# <img src="src/client/public/icons/pipali_64.png" width="28" height="28" alt="HeyJada logo" /> HeyJada (Beta)

[![Download HeyJada](https://img.shields.io/badge/Download_HeyJada-%E2%86%93-1a1a1a?style=for-the-badge&labelColor=1a1a1a&color=525252)](https://github.com/itsablabla/heyjada-beta/releases)

An AI co-worker on your computer that can safely interact with files + the web to finish real work.

- **Research** across your docs and the web
- **Create** docs, spreadsheets, email, events and personal apps
- **Automate** routine workflows

<img width="1287" height="825" alt="product_hero" src="https://github.com/user-attachments/assets/85e90271-95a5-4f87-9011-c9a375719f8f" />

## Features

### Work Async
Assign HeyJada a few tasks and go grab a coffee. Track progress, give feedback and get notified when HeyJada needs your attention.

### Create polished deliverables
Turn messy inputs into shareable outputs — briefs, decision memos, project updates, meeting notes, and spreadsheets.

### Automate routine work
Set up tasks on a schedule or trigger them manually. "Draft my weekly project update email", "Sync my ledger on the 1st of every month", "Mark all marketing emails as spam".

### Teach it your workflows
Ask HeyJada to create [skills](https://agentskills.io/) for all your custom workflows - where to find project documents, which accounting method to follow or your email organization policy.

### Connect your tools
Integrate Jira, Linear, Slack etc. via MCP. HeyJada can create issues, post messages, and interact with external APIs on your behalf.

### Use your favorite AI models
Use the right AI model for the right task. Model access is provided through the HeyJada Platform — Single Sign On, no API key setup needed.

### Run safely
HeyJada runs commands safely in a local sandbox that restricts file and network access. This reduces your confirmation fatigue while it works safely on your computer.
Commands that need broader access require your explicit approval. You can configure these permissions yourself.

## Starter Prompts

- "We have not been properly introduced"
- "Summarize the last 5 PDFs in my Downloads folder into a professional 1-page brief."
- "Make me a personal newspaper from today's top stories, styled like the NYT front page"
- "Find all images on my Downloads folder and create a mood board webpage from them"
- "Turn my recent screenshots into a story describing my week"

## Get Started

1. [Download](https://github.com/itsablabla/heyjada-beta/releases) the app for macOS, Windows or Linux
2. Sign in from the Desktop app
3. Assign HeyJada a task

## Run on a Remote Server (Web App)

HeyJada can run headless on a server and be used from any browser — and installed as a Web App (PWA).

```bash
# Start the server on all interfaces, protected by HTTP Basic Auth
HEYJADA_AUTH_USERNAME=admin HEYJADA_AUTH_PASSWORD=change-me \
bun start -- --host 0.0.0.0 --port 6464
```

- **Basic authentication** — set `HEYJADA_AUTH_USERNAME` and `HEYJADA_AUTH_PASSWORD` (or pass `--auth-username` / `--auth-password`) and every route, including the WebSocket and API, requires the username and password. A warning is logged if you expose the server beyond localhost without credentials.
- **Install as a Web App** — open HeyJada in your browser and use "Install app" (Chrome/Edge) or "Add to Home Screen" (iOS/Android). The served web manifest gives you a standalone app window with the HeyJada icon.
- **HTTPS** — for remote access, put HeyJada behind a TLS reverse proxy (e.g. Caddy or nginx); browsers require a secure context to install the Web App and to keep Basic Auth credentials safe.

## FAQ

- **Do I need to set up billing?**<br />
  Individual users and Team admins should set up billing before the initial signup credits run out.

- **Do I need API keys?**<br />
  No — model access is provided via the HeyJada Platform.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, and guidelines.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
