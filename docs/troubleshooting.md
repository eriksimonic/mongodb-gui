# Troubleshooting

Each section starts with the symptom you see, then lists the causes and fixes. The messages in
quotes are the text the app shows.

## Cannot connect

The app shows the error as a title and a detail line. The title tells you which step failed.

| Title                             | Meaning                                                                                             | What to check                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Authentication failed"           | The server rejected the user name or password.                                                      | The user name and password. The "Auth database" field, which must hold the database where the user was created. For a root user from a Docker image, that is usually `admin`. |
| "Could not connect to the server" | The app could not open a network connection, or the name did not resolve. The detail line says why. | The host and port. That the server is running and reachable from your machine. For `mongodb+srv`, that DNS can resolve the SRV record. A VPN or firewall.                     |
| "Connection timed out"            | The server did not answer within "Connect timeout (ms)".                                            | The host and port. A firewall that drops packets. Raise the timeout only after the host and port are right.                                                                   |
| "The server rejected the command" | The server answered and refused the command. The detail line shows the server message.              | The permissions of the user. The "Auth database" field.                                                                                                                       |
| "Connect to the server first."    | You ran a statement or opened a panel before the connection opened.                                 | Connect first, then run the statement again.                                                                                                                                  |

Steps for a failed connection:

1. Open the connection with "Edit" and click "Test connection". The test runs the same
   checks as a connect, and it shows the server version when it succeeds.
2. For a TLS server, turn on "Use TLS". Set "CA file path" for a private certificate authority.
   "Allow invalid certificates" skips the certificate check. Use it only to test a server with a
   bad certificate.
3. For a replica set, set "Replica set name" to the name of the set. Use the members of the set as
   the hosts.

## Docker discovery finds nothing

The Docker node is missing or empty. Check the reason first. The Docker node shows the reason
the engine cannot be reached. The reason names the socket that the app tried.

- "Permission denied on ..." means your user cannot read the Docker socket. On Linux, add your user
  to the `docker` group, then sign out and sign in again. The group change does not apply to a
  session that is already open.
- "Docker is not reachable at ..." means the app found no engine at that socket. Start Docker, or
  check that the socket exists. The app uses `/var/run/docker.sock` on Linux and macOS, and the
  `docker_engine` named pipe on Windows. A `DOCKER_HOST` value that starts with `unix://` changes
  the socket on Linux and macOS. Other `DOCKER_HOST` values are ignored.
- Docker Desktop must be running on macOS and Windows. The Docker node refreshes every 10 seconds,
  so it shows the containers once the engine answers.

If the engine answers but the container is not listed, check these:

- The image must be one of `mongo`, `mongodb/*`, `bitnami/mongodb` or
  `percona/percona-server-mongodb`, or the container must expose port 27017. A MongoDB container
  built from another image and without port 27017 is not listed. Connect to it with the connection
  dialog instead.
- The list includes stopped containers, and each row shows its state. A stopped container does not
  accept connections. Start the container first.

A container that is listed but does not connect may not publish port 27017. The app then starts a
forwarder container. The forwarder uses the `alpine/socat` image. If the machine cannot pull that
image, the connection fails. Pull the image yourself with `docker pull alpine/socat:1.8.1.3`, then
try again.

## The AppImage does not start on Linux

The app runs its window with Chromium's sandbox. Chromium needs unprivileged user namespaces. On
some systems the sandbox fails to start, and the app exits before its window appears. The terminal
often shows an error that mentions the sandbox. Common causes are these:

- Ubuntu 24.04 and later restrict unprivileged user namespaces with AppArmor by default.
- The distribution does not allow user namespaces.

Allow unprivileged user namespaces on the system. This changes a system security setting, so make
that choice on purpose. The app does not turn the sandbox off. Do not run it with `--no-sandbox` for
daily use.

## The updater on each platform

The app checks for updates about 10 seconds after you unlock it, and then every six hours. A
check that fails stays out of sight. The next check runs on schedule. To stop checks, turn off
"Check for updates" in Settings.

- AppImage and Windows installer. Click "Download" in the update notice. Click "Restart to update"
  when the download finishes, or "Later" to install when you quit.
- Other Linux installs. The app installs an update only when the `APPIMAGE` variable is set, which
  the AppImage launcher does. Other installs show "Download from GitHub".
- `.deb` and macOS. The app cannot replace itself. Click "Download from GitHub", then install the
  new version by hand.
- No notice at all. The machine may be offline, or "Check for updates" may be off. Check the
  setting in Settings, then wait for the next check or restart the app.

## The vault will not unlock

- "The vault has not been set up yet." The app has no `keyring.json` in its data directory. Create
  a master password on the first-run screen. If you expected your data, check the data directory
  for the files. See [security.md](security.md#what-is-encrypted-and-where-it-lives).
- The unlock fails with an internal error. The `keyring.json` file is damaged. Restore it from a
  backup if you have one. Otherwise, use "Reset store" on the unlock screen. The reset deletes the
  saved data.

## A wrong master password

The app shows "The master password is incorrect." Check these points before you try again:

1. The keyboard layout and Caps Lock. A password with a symbol may use a different key on another
   layout.
2. Trailing spaces. The app compares the exact text.

Each failed attempt waits 500 milliseconds. The app has no recovery for a forgotten password. Use
"Reset store" to start again. The reset deletes the saved data.

## The app window does not appear

The app shows its window when the first page finishes loading. On some Linux desktops, the window
never shows, and the app stays hidden. Check these points:

1. Start the app from a terminal. A startup failure prints `startup failed` and exits with code 1.
2. Check that the process runs. On Linux, `pgrep -fa mongo-gui` lists it.
3. Start the app with `MONGO_GUI_LOG_LEVEL=debug` set. The terminal then prints debug lines from
   the logger.

## Slow explain on large collections

An explain with "Verbosity" set to `executionStats` or `allPlansExecution` runs the query on the
server. A query that scans a large collection takes as long as the query itself.

1. Set "Verbosity" to `queryPlanner` first. The server returns the plan without running the query.
2. Read the stage tree. A "COLLSCAN" stage means the query scans the collection. Find the field
   the query filters or sorts on.
3. Create an index on that field in the "Indexes" panel. Then explain again.
4. Use `executionStats` only when you need the counts and the timings.

## Where the logs are

The app writes its logs to standard error. It does not write a log file. A log line is one JSON
object with `time`, `level`, `message` and `fields`. Passwords in URIs are masked.

To read the logs, start the app from a terminal:

- On Linux, run `mongo-gui`, or the AppImage file, from a terminal.
- On Windows, start the app from a PowerShell or Command Prompt window. The log lines go to the
  console that the app was started from.
- In development, run `pnpm dev` from the repository root.

Set `MONGO_GUI_LOG_LEVEL=debug` to include the debug lines.

## Report a bug

Open an issue at [github.com/eriksimonic/mongodb-gui](https://github.com/eriksimonic/mongodb-gui).
Include these details:

1. The app version. Open Settings and read the "Version" line in the About section. The same
   section lists the Electron, Chromium and Node.js versions.
2. Your operating system and its version. On Linux, include the desktop and the install method
   (AppImage or `.deb`).
3. The MongoDB server version and its topology. Name the topology as standalone, replica set or
   sharded cluster.
4. The steps that trigger the bug, and what you expected to happen.
5. The log lines from the terminal around the failure. Read them before you post them. The app
   masks passwords in URIs, but check the lines for document contents and host names you do not
   want to share.
