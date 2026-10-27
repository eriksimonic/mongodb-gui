# Keyring setup on Linux

Machine encryption stores the data key in the keyring of your desktop session. On Linux, the app
needs a running keyring. Without one, the app refuses machine encryption, because the key would
sit in plain text. Password encryption works without a keyring.

The app reports one of three reasons when machine encryption is off:

- No keyring is running, so Linux would keep the key in plain text.
- The app could not tell which keyring this desktop uses.
- The system offers no key storage for your user account.

The fix is the same for all three. Set up GNOME Keyring or KWallet, then restart the app.

## GNOME Keyring

GNOME Keyring comes with GNOME and most Ubuntu and Fedora desktops. On Debian and Ubuntu, install
the packages with:

```sh
sudo apt install gnome-keyring libsecret-tools
```

On Fedora, install `gnome-keyring` and `libsecret` with `dnf`.

Log out and log in again, or start the daemon for this session:

```sh
gnome-keyring-daemon --start --components=secrets
```

Check that the keyring answers. The first command asks for a secret, and the lookup prints it back:

```sh
secret-tool store --label="keyring test" service mongo-gui-test
secret-tool lookup service mongo-gui-test
secret-tool clear service mongo-gui-test
```

If `lookup` prints nothing, the keyring is not running. Start it as shown above, then run the
check again.

## KWallet

KDE Plasma installs KWallet with the desktop. Open `kwalletmanager` from the application menu to
check that a wallet exists. The default wallet is named `kdewallet`.

If KWallet is missing, install `kwallet6` on Plasma 6, or `kwalletmanager` for the wallet window,
then log out and log in again.

## Choose the keyring with a flag

Electron picks the keyring when the app starts. Most desktops pick the right one on their own. If
the app still reports the keyring as missing, start it with a flag that names the keyring:

- `--password-store=gnome-libsecret` for GNOME Keyring.
- `--password-store=kwallet5` for KWallet on Plasma 5.
- `--password-store=kwallet6` for KWallet on Plasma 6.

For the AppImage, pass the flag on the command line:

```sh
./<AppImage file> --password-store=gnome-libsecret
```

To start the app from the application menu, add the flag to the `Exec=` line of its desktop entry.
Copy the entry to `~/.local/share/applications/` first, so that a package update does not replace
the change:

```ini
Exec=/path/to/<AppImage file> --password-store=gnome-libsecret %U
```

## Restart the app

Linux picks the keyring when the app starts. After you set up a keyring, quit the app and start it
again. Clicking "Check again" in the app does not restart it, so the check can still report the
old answer.
