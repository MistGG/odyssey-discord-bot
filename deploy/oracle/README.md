# Deploy on Oracle Cloud Always Free

Run the bot 24/7 on an Oracle **Always Free** VM (Ubuntu). No credit card charges as long as you stay within free tier limits.

**Repo:** https://github.com/MistGG/odyssey-discord-bot

---

## 1. Create the VM (OCI Console)

1. Sign in at [cloud.oracle.com](https://cloud.oracle.com).
2. **Compute → Instances → Create instance**.
3. **Name:** `odyssey-bot` (or anything).
4. **Image:** Ubuntu 22.04 or 24.04 (aarch64 for Ampere, x86 for AMD micro).
5. **Shape (pick one Always Free option):**
   - **Ampere A1 Flex** — `VM.Standard.A1.Flex` with **1 OCPU**, **6 GB RAM** (recommended; plenty of headroom).
   - **AMD Micro** — `VM.Standard.E2.1.Micro` (1 GB RAM; enough for this bot).
6. **Networking:** Create/use a VCN with **Assign a public IPv4 address** enabled.
7. **SSH keys:** Generate or upload a key pair. Download the private key if OCI generates it.
8. **Boot volume:** Default (up to 200 GB total free across instances).
9. Click **Create**.

If Ampere shows **Out of host capacity**, try another **region** (e.g. Phoenix, Ashburn, Frankfurt) or use the AMD micro shape.

---

## 2. Open SSH (Security List)

1. **Networking → Virtual cloud networks** → your VCN → **Security Lists** → default.
2. **Add ingress rule:**
   - Source: **Your IP** (or `0.0.0.0/0` only while testing — tighten later).
   - IP Protocol: TCP
   - Destination port: **22**

No inbound rules are needed for the Discord bot itself (it only makes outbound connections).

---

## 3. SSH into the instance

From your PC (replace paths/IPs):

```bash
ssh -i ~/.ssh/oci_key ubuntu@YOUR_PUBLIC_IP
```

Default user is usually `ubuntu` on Ubuntu images.

---

## 4. Run the setup script

On the VM:

```bash
curl -fsSL https://raw.githubusercontent.com/MistGG/odyssey-discord-bot/master/deploy/oracle/setup.sh | bash
```

Or clone first and run locally:

```bash
git clone https://github.com/MistGG/odyssey-discord-bot.git
cd odyssey-discord-bot
bash deploy/oracle/setup.sh
```

---

## 5. Configure secrets

```bash
nano ~/odyssey-discord-bot/.env
```

Set at minimum:

```env
DISCORD_BOT_TOKEN=your_token
DISCORD_CLIENT_ID=your_app_id
```

Optional: `DISCORD_DEV_GUILD_ID`, `DISCORD_ALERT_CHANNEL_ID`, `RAID_POLL_MS`, etc. (see `.env.example`).

Then start (or restart) the service:

```bash
sudo systemctl restart odyssey-discord-bot
```

---

## 6. Verify

```bash
sudo systemctl status odyssey-discord-bot
sudo journalctl -u odyssey-discord-bot -f
```

You should see `Logged in as YourBot#1234`. In Discord, run `/setup show` to confirm guild config.

Guild settings persist in `~/odyssey-discord-bot/data/guild-config.json` on the VM.

---

## Updating the bot

```bash
cd ~/odyssey-discord-bot
git pull
npm ci
npm run build
sudo systemctl restart odyssey-discord-bot
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| SSH timeout | Check security list port 22, instance running, correct public IP |
| `Out of host capacity` | Change region or use AMD E2.1.Micro |
| Bot exits immediately | `journalctl -u odyssey-discord-bot -n 50` — usually missing/invalid token |
| Slash commands missing | Set `DISCORD_CLIENT_ID`; restart bot; wait ~1 min (guild) or up to 1 hr (global) |
| Alerts not posting | Run `/setup alert-channel` and `/setup patch-notes-channel` in Discord |

---

## Always Free limits (summary)

- **2 AMD micro VMs** *or* **Ampere A1** up to 4 OCPUs + 24 GB RAM total (split across instances).
- **200 GB** block storage total.
- **10 TB/month** egress (more than enough for this bot).

Stay within these and you are not charged for compute/storage on Always Free resources.
