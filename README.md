# zing-forms-service

Central form submission API for ZING customer websites. Receives contact/quote form submissions and routes them to the correct business owner via email (SMTP2GO).

## Setup

```bash
git clone https://github.com/seanzing/zing-forms-service.git
cd zing-forms-service
npm install
cp .env.example .env
# Edit .env with your SMTP2GO API key and admin key
```

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3006) |
| `SMTP2GO_API_KEY` | Your SMTP2GO API key |
| `SMTP2GO_FROM_EMAIL` | Sender email address |
| `SMTP2GO_FROM_NAME` | Sender display name |
| `ADMIN_KEY` | Secret key for admin endpoints |

## Running

```bash
npm start
```

## Adding a New Site

### Via Admin API

```bash
curl -X POST http://localhost:3006/admin/sites/mysite \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{"businessName": "My Business", "ownerEmail": "me@example.com", "formTypes": ["contact"]}'
```

### Manual Edit

Add an entry to `data/sites.json`:

```json
{
  "mysite": {
    "businessName": "My Business",
    "ownerEmail": "me@example.com",
    "formTypes": ["contact"]
  }
}
```

## Form Submission Example

```bash
curl -X POST http://localhost:3006/submit \
  -H "Content-Type: application/json" \
  -d '{
    "site_id": "mooreroofing",
    "name": "John Smith",
    "email": "john@example.com",
    "phone": "555-1234",
    "message": "I need a roof inspection.",
    "form_type": "contact"
  }'
```

## Deploy to Railway

1. Push this repo to GitHub
2. Connect the repo in [Railway](https://railway.app)
3. Set environment variables in Railway dashboard
4. Railway auto-detects the `Procfile` and deploys

The service runs on the port assigned by Railway's `PORT` variable.
