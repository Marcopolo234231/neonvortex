# Neon Vortex auf dem Raspberry Pi

Der Server liefert das Spiel aus und speichert **Konten und Spielstände** auf dem Pi.
Er braucht nur **Node.js**, sonst nichts.

## Was er kann

- Konto erstellen, anmelden, abmelden
- Spielstand wird automatisch gespeichert (nach jedem Lauf und bei Änderungen im Menü)
- **Kein Name doppelt:** Gross/Klein zählt nicht („Marco“ = „marco“), auch Leerzeichen am Rand nicht
- **Sonderzeichen:** Namen dürfen Buchstaben aus allen Sprachen (ä, ö, ü, é, ß …), Zahlen, Leerzeichen und `_ - .` enthalten, 3 bis 16 Zeichen.
  Zeichen wie `< > / \ " '` und Emojis sind nicht erlaubt. Passwörter dürfen jedes Zeichen enthalten (mindestens 6).
- Passwörter werden nur gehasht gespeichert (scrypt), nie im Klartext
- Schutz gegen Passwort-Raten: nach 10 Fehlversuchen ist die IP 15 Minuten gesperrt
- Höchstens 5 neue Konten pro Stunde und IP

## Installation

```bash
sudo apt update
sudo apt install -y nodejs git
node --version          # muss 18 oder neuer sein
cd ~
git clone https://github.com/Marcopolo234231/neonvortex.git
node neonvortex/server/server.js
```

Dann im Browser (im gleichen WLAN): `http://<IP-vom-Pi>:8080`
Die IP findest du mit `hostname -I`.

## Automatisch starten

```bash
mkdir -p ~/neonvortex-daten
sudo cp ~/neonvortex/server/neonvortex.service /etc/systemd/system/
sudo systemctl enable --now neonvortex
systemctl status neonvortex      # sollte "active (running)" zeigen
```

Heisst dein Benutzer nicht `pi`, ändere `User=` und die Pfade in der Datei.

## Update einspielen

```bash
cd ~/neonvortex && git pull && sudo systemctl restart neonvortex
```

Die Spielstände liegen in `~/neonvortex-daten` und bleiben bei Updates erhalten.

## SD-Karte schonen

Der Server schreibt sehr wenig: eine kleine Datei pro Konto, nur wenn sich etwas ändert.
Was sonst am meisten auf die SD-Karte schreibt, kannst du so abstellen:

1. **Systemlogs nur im RAM:** in `/etc/systemd/journald.conf` die Zeile `Storage=volatile` setzen, dann `sudo systemctl restart systemd-journald`
2. **Swap aus:** `sudo systemctl disable --now dphys-swapfile` (nur wenn der Pi genug RAM hat, z. B. 2 GB oder mehr)
3. **Am besten:** die Daten auf einen **USB-Stick oder eine USB-SSD** legen, z. B. `NV_DATA=/mnt/usb/neonvortex-daten` in der Service-Datei

Wichtig: Das **Overlay-Dateisystem** (read-only) aus `raspi-config` geht hier nicht, sonst sind die Spielstände nach einem Neustart weg.
Ausser du legst `NV_DATA` auf einen USB-Stick.

## Backup

Einfach den Ordner kopieren:

```bash
tar czf neonvortex-backup.tgz -C ~ neonvortex-daten
```

## Von unterwegs spielen

Im WLAN zu Hause geht es sofort. Von aussen gibt es zwei einfache Wege ohne Port-Freigabe am Router:

- **Tailscale** (am einfachsten): auf dem Pi und auf deinem Gerät installieren, dann über die Tailscale-IP spielen. Nur deine eigenen Geräte haben Zugriff.
- **Cloudflare Tunnel**: Damit bekommst du eine öffentliche HTTPS-Adresse, über die Freunde mitspielen können. Setze dann in der Service-Datei zusätzlich `Environment=TRUST_PROXY=1`, damit die Sperre bei Fehlversuchen die richtige IP sieht.

Die Version auf GitHub Pages bleibt wie bisher bei **lokalen Profilen**. Konten gibt es nur, wenn das Spiel über den Pi geöffnet wird.
