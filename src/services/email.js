const axios = require('axios');

async function sendEmail({ site, site_id, name, email, phone, message, form_type }) {
  const apiKey = process.env.SMTP2GO_API_KEY;
  const fromEmail = process.env.SMTP2GO_FROM_EMAIL || 'noreply@zingmigration.com';
  const fromName = process.env.SMTP2GO_FROM_NAME || 'ZING Website Forms';

  const subject = `New ${form_type} from ${name} — ${site.businessName}`;
  const timestamp = new Date().toISOString();

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333; border-bottom: 2px solid #0066cc; padding-bottom: 10px;">
        New ${form_type} submission
      </h2>
      <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
        <tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555; width: 120px;">Name</td>
          <td style="padding: 8px 12px;">${escapeHtml(name)}</td>
        </tr>
        ${email ? `<tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555;">Email</td>
          <td style="padding: 8px 12px;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td>
        </tr>` : ''}
        ${phone ? `<tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555;">Phone</td>
          <td style="padding: 8px 12px;"><a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a></td>
        </tr>` : ''}
        ${message ? `<tr>
          <td style="padding: 8px 12px; font-weight: bold; color: #555; vertical-align: top;">Message</td>
          <td style="padding: 8px 12px; white-space: pre-wrap;">${escapeHtml(message)}</td>
        </tr>` : ''}
      </table>
      <p style="margin-top: 24px; font-size: 12px; color: #999;">
        Submitted at ${timestamp}<br>
        Site: ${escapeHtml(site_id)} (${escapeHtml(site.businessName)})
      </p>
    </div>
  `;

  const payload = {
    api_key: apiKey,
    to: [`${site.businessName} <${site.ownerEmail}>`],
    sender: `${fromName} <${fromEmail}>`,
    subject,
    html_body: htmlBody
  };

  if (email) {
    payload.custom_headers = [{ header: 'Reply-To', value: email }];
  }

  try {
    const response = await axios.post('https://api.smtp2go.com/v3/email/send', payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });

    if (response.data && response.data.data && response.data.data.succeeded > 0) {
      return true;
    }

    console.error('[EMAIL] SMTP2GO did not confirm success:', response.data);
    return false;
  } catch (err) {
    console.error('[EMAIL] SMTP2GO error:', err.response?.data || err.message);
    return false;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendEmail };
