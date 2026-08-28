/**
 * Outbound mail, which this application sends exactly one of.
 *
 * Accounts are issued by hand on the server, so someone who lands on the
 * sign-in page with no account has nowhere to go and no way to ask. This
 * carries that ask to whoever runs the instance.
 *
 * Everything is read from the environment at send time rather than at import,
 * so a deployment that has not configured mail starts normally and simply does
 * not offer the form. `mailConfigured()` is what the gate page asks.
 */

import nodemailer, { type Transporter } from 'nodemailer';

export interface MailConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Envelope sender. IONOS requires this to be the authenticated mailbox. */
  from: string;
  /** Where access requests land. */
  to: string;
}

/**
 * The mail settings, or null if any of them is missing.
 *
 * All or nothing on purpose: a half-configured transport fails at send time,
 * which is after the person has typed their request and been told it was sent.
 */
export function mailConfig(): MailConfig | null {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM?.trim() || user;
  const to = process.env.ACCESS_REQUEST_TO?.trim() || from;
  const port = Number(process.env.SMTP_PORT ?? 587);

  if (!host || !user || !pass || !from || !to || !Number.isFinite(port)) return null;
  return { host, port, user, pass, from, to };
}

export function mailConfigured(): boolean {
  return mailConfig() !== null;
}

let cached: { key: string; transport: Transporter } | null = null;

/**
 * One transport per configuration, reused across requests.
 *
 * The server is a long-lived Node process, so this keeps the SMTP connection
 * pool rather than opening a socket per message. Keyed on the settings so a
 * changed environment cannot be served by a stale transport.
 */
function transportFor(cfg: MailConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (cached?.key === key) return cached.transport;
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    // 465 is implicit TLS; 587 opens plain and upgrades with STARTTLS.
    secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 1,
  });
  cached = { key, transport };
  return transport;
}

export interface AccessRequest {
  email: string;
  /** Who they are and why they want in. Free text, already length-capped. */
  note: string;
  /** Best guess at the requester's address, for blocking abuse. */
  ip: string | null;
  at: Date;
}

/**
 * Mail one access request to the operator.
 *
 * The requester's address goes in the body and in `replyTo`, never into a
 * header this builds by hand — and the caller has already rejected anything
 * with a control character in it, which is what would let a crafted address
 * write headers of its own. The subject is fixed for the same reason.
 */
export async function sendAccessRequest(req: AccessRequest): Promise<void> {
  const cfg = mailConfig();
  if (!cfg) throw new Error('mail is not configured');

  const lines = [
    'Someone asked for a PAC Tracker account.',
    '',
    `Email:   ${req.email}`,
    `When:    ${req.at.toISOString()}`,
    `From IP: ${req.ip ?? 'unknown'}`,
    '',
    'What they said:',
    req.note.trim() || '(nothing)',
    '',
    '—',
    'To issue the account, on the server:',
    `  docker compose run --rm cli pnpm user add ${req.email}`,
    '',
    'That prints a temporary password they must change on first sign-in.',
  ];

  await transportFor(cfg).sendMail({
    from: cfg.from,
    to: cfg.to,
    replyTo: req.email,
    subject: 'PAC Tracker — account request',
    text: lines.join('\n'),
  });
}
