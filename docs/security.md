# Security

This document describes how Mongo GUI protects the data it stores, what it never stores or
logs, and which process runs which code. It is written for users and for reviewers. For the
original design notes, see [PLAN.md](PLAN.md).

## Threat model

The app protects the data it saves on your machine. That data covers connection settings with their
credentials, query history, favourites and app settings. The main threat is someone who copies
the app's data directory, or a backup of it, and reads it on another machine. The app encrypts
that data under a key that comes from a master password you type.

The app does not protect against code that runs as your user while the app is unlocked. Such
code can read the same memory and the same connections that the app uses. The same holds for
any program that can attach to the app process. Keep the machine itself secure and lock the app
when you step away.

The query runtime runs your statements. A statement has the same access as the connection it
runs on. The runtime has no access to the stored data, and it holds only the connection details
it needs for the open connection. See [The mongosh runtime](#the-mongosh-runtime).

## Master password and key hierarchy

The master password derives a key that encrypts a random data key. The data key encrypts every
stored record.

```
master password --scrypt(N=2^17, r=8, p=1, 32-byte salt)--> key encryption key (32 bytes)
key encryption key --AES-256-GCM unwrap--> data key (32 bytes, random)
data key --AES-256-GCM--> every stored record
```

- The app normalises the password to Unicode NFC before it derives the key.
- The app requires at least 10 characters for a new master password.
- At the first launch, the app creates the data key, wraps it under the key encryption key, and
  writes the wrapped key to `keyring.json`. The authentication tag of the wrapped key checks the
  password. The file has no separate password hash.
- A wrong password gets the message "The master password is incorrect." Each failed unlock
  waits 500 milliseconds before the next check.
- Changing the password derives a new key encryption key and wraps the data key again. The stored
  records stay as they are.
- The data key exists only in the memory of the main process. The app clears it when you lock,
  when you quit, and after the idle lock period. The default idle lock period is 30 minutes. You
  can change it in Settings.
- The renderer process never receives the data key. Neither does the runtime process.

## What is encrypted and where it lives

The app stores its data in its user data directory. Electron builds that path from the product
name "Mongo GUI":

| Operating system | Directory                                               |
| ---------------- | ------------------------------------------------------- |
| Linux            | `~/.config/Mongo GUI` (or `$XDG_CONFIG_HOME/Mongo GUI`) |
| Windows          | `%APPDATA%\Mongo GUI`                                   |
| macOS            | `~/Library/Application Support/Mongo GUI`               |

The directory holds two files:

- `keyring.json` holds the key derivation settings, the salt and the wrapped data key. The app
  creates the directory with mode 0700 on Linux and macOS. Windows applies its own file permissions.
- `store.sqlite` is the encrypted database. It has tables for connections, history, favourites,
  settings and layout.

Every table stores its data in one `payload` column. The payload is encrypted with AES-256-GCM.
Each payload uses a fresh 12-byte nonce, and it carries a 16-byte tag. The additional data for
each payload is the table name and the row id, so a payload copied to another row fails to
decrypt.

Some columns stay in clear text:

- Row ids and timestamps.
- The `connection_id` and `started_at` columns of history. A reader of the file can see when
  each query ran and which connection it used, but not the query text.
- The keys of the settings and layout tables. A reader can see the names of the settings.

History is capped at 20,000 entries by default. Removing a connection removes its history.

## Connection export files

Settings, Data, "Export connections" writes the connections you select to a file. The file holds
the full connection profiles, credentials included, so the file is encrypted under a passphrase
that you type for that export. The passphrase is not the master password, and the file does not
depend on the vault.

- The key comes from scrypt with the vault's parameters: N = 2^17, r = 8, p = 1. Each export draws
  a new 32-byte salt.
- The payload is encrypted with AES-256-GCM. Each export draws a new 12-byte IV.
- The authenticated data covers the format name, the version, the scrypt parameters, the salt and
  the IV. A changed header fails the check.
- The passphrase must be 10 to 1024 characters. The app does not store it, and it cannot recover
  it. A lost passphrase means the file cannot be opened.
- The GCM tag is the only check on the passphrase. A wrong passphrase and a damaged file give the
  same message.
- The app never logs, records in history or returns the passphrase. Error messages do not repeat
  it.

The file is one JSON object:

```json
{
  "format": "mongo-gui-connections",
  "version": 1,
  "kdf": { "name": "scrypt", "N": 131072, "r": 8, "p": 1, "salt": "<base64, 32 bytes>" },
  "cipher": { "name": "aes-256-gcm", "iv": "<base64, 12 bytes>", "tag": "<base64, 16 bytes>" },
  "payload": "<base64 ciphertext of a JSON array of connection profiles>"
}
```

Import refuses a file with another format name or another version. It also refuses a file whose
scrypt parameters fall outside these bounds, before any key is derived:

- N is a power of two between 2^14 and 2^20.
- r is between 1 and 16, and p is between 1 and 4.
- 128 * r * (N + 2 + p) is at most 256 MiB, which is the memory scrypt allocates.

Import also refuses a file larger than 8 MiB. The preview and
the import each read and decrypt the file.

## What is never stored or logged

- The master password is never written to disk. The app keeps only the key derivation settings
  and the wrapped data key.
- The app never writes a connection string with a password to a log. Log lines pass through a
  redaction helper, which replaces the password in any `mongodb://` or `mongodb+srv://` URI with
  `***`.
- Driver errors that contain a URI pass through the same redaction before the app shows them.
- Container environment variables appear by name only in the Docker details panel. The values
  never appear.

The app writes its logs to standard error. It does not write a log file. See
[troubleshooting.md](troubleshooting.md#where-the-logs-are).

## The mongosh runtime

The statements you type run in a separate utility process, one for each open connection. The main
process starts it, and it runs the mongosh runtime with the MongoDB driver.

- A crash or a runaway statement affects only that connection's process. The app shows the
  error for that connection. It restarts the process after a crash, up to three times within 60
  seconds. After that, the connection needs a manual restart.
- The runtime receives the connection details for its own connection on demand. It does not
  receive the data key, and it does not read the store.
- The renderer never runs your statements. It sends the text to the main process, and the main
  process sends it to the runtime.

## Renderer and window rules

- The renderer runs with `contextIsolation` on, `nodeIntegration` off, `sandbox` on and
  `webSecurity` on.
- The app sends a Content Security Policy with each page. In a packaged build, scripts load only
  from the app itself. Styles load from the app and may be inline. Monaco workers run as `blob:`
  URLs.
- The window denies every request to open a new window. It also blocks navigation to any page
  that the app did not ship. Webviews are refused.
- The renderer reaches the main process only through the typed RPC bridge. The bridge exposes
  calls from one fixed contract.

## External links

The app opens a link in the system browser only when it points to a page of the project on GitHub.
The main process checks the link before it opens it. Any other address is refused with a
validation error. The update notice uses this path for its "Download from GitHub" and "Open on
GitHub" buttons.

## File dialog rules

The renderer never picks a file path. The main process opens every file dialog, and it returns
only the path that you choose.

- Import reads only a file that you picked in an open dialog during this session.
- An export writes only to a path that you picked in a save dialog. A pick covers one write. The
  app writes to a temporary file beside the target and then renames it over the target, so a
  reader sees either the old file or the new one.
- The app never overwrites a file that you did not pick.
- The app refuses a path that contains `..`, and a path that is a symbolic link.
- A connection export writes only to a path you picked in a save dialog. The pick is used up once
  the export has written the file.
- An import reads a connections file only after you pick it in an open dialog. The pick stays
  usable while the passphrase is wrong, and it is used up after a successful import.
- A GridFS download writes only to a file you picked, or to a file in a folder you picked.
- "Show in folder" reveals only a file that the app exported during this session.

## When you forget the master password

The app cannot recover the data. The data key is wrapped only under the master password, and the
app keeps no copy of it. A forgotten password leaves the stored data unreadable.

To use the app again, choose "Reset store" on the unlock screen. Type `DELETE` and click "Delete
store". The reset removes `store.sqlite` and `keyring.json`. The app then asks you to create a new
master password. Saved connections, history, favourites and settings are gone.

If you want a copy of your saved connections, keep your own record of their URIs and credentials
before you forget the password.
