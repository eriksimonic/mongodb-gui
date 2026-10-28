# Keyring setup on Linux

Machine encryption stores the data key in your desktop keyring. Without a running keyring the app
refuses machine encryption, because Electron would store the key in plain text. Password encryption
works without a keyring.

When machine encryption is off, the app shows one of three reasons:

- `basic-text`: no keyring is running, so Electron falls back to plain-text storage.
- `unknown-backend`: Electron cannot tell which keyring this desktop uses.
- `no-encryption`: the system offers no key storage for your user account.

The fix is the same for all three: set up GNOME Keyring or KWallet, then restart the app.

## GNOME Keyring

On Debian and Ubuntu, install the packages:

```sh
sudo apt install gnome-keyring libsecret-tools
```

On Fedora, install `gnome-keyring` and `libsecret` with `dnf`.

Log out and log in again, or start the daemon for this session:

```sh
gnome-keyring-daemon --start --components=secrets
```

Check that the keyring answers. `store` asks for a value, so type any text:

```sh
secret-tool store --label="keyring test" service mongo-gui-test
secret-tool lookup service mongo-gui-test
secret-tool clear service mongo-gui-test
```

If `lookup` prints nothing, the keyring is not running. Start it, then run the check again.

## KWallet

KDE Plasma installs KWallet with the desktop. Open `kwalletmanager` to check that a wallet exists.
The default wallet is `kdewallet`.

If KWallet is missing, install `kwallet6` on Plasma 6 or `kwalletmanager` for the wallet window,
then log out and log in again.

## Select the keyring with a flag

The app sets no keyring flag. Electron picks the storage backend from your desktop session when
the app starts, and most desktops get it right. Pass a flag only if the app still reports a
missing keyring after setup:

- `--password-store=gnome-libsecret` for GNOME Keyring.
- `--password-store=kwallet5` for KWallet on Plasma 5.
- `--password-store=kwallet6` for KWallet on Plasma 6.

For the AppImage, pass the flag on the command line:

```sh
./<AppImage file> --password-store=gnome-libsecret
```

To start the app from the application menu, copy its desktop entry to
`~/.local/share/applications/`, so a package update does not replace the change. Then add the flag
to the `Exec=` line:

```ini
Exec=/path/to/<AppImage file> --password-store=gnome-libsecret %U
```

## Restart the app

The backend is chosen at startup, so quit the app and start it again after you change the keyring
or the flag. "Check again" in the app does not restart it and can show the old result.
