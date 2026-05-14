// Mailer abstraction for the platform server.
//
// Two implementations:
//
//   - ConsoleMailer: logs the rendered email to stdout. Used in dev so
//     the wallet can drive the recovery flow without any SMTP. Always
//     also records the most recent email per `to` address in memory so
//     tests can read it back.
//
//   - SmtpMailer: real SMTP via nodemailer. Used in prod against any
//     SMTP-compatible provider (Resend, SendGrid, Amazon SES, etc).
//     Config via env vars (see config.ts).
//
// Why an abstraction at all: keeping the route handlers blind to the
// transport means we never accidentally need a live SMTP server in the
// test suite. Tests use ConsoleMailer with its recordedEmails map.
//
// Email templates are inlined here rather than in a separate file. There
// are two of them, both tiny, and a future move to a more sophisticated
// template engine is straightforward.

import { createTransport, type Transporter } from 'nodemailer';
import { type PlatformConfig } from './config.js';

export interface SendArgs {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(args: SendArgs): Promise<void>;
}

/**
 * In-process mailer. Logs every email to stdout AND records the most
 * recent email per recipient so tests can inspect what would have been
 * sent. Useful for dev and the entire test suite.
 */
export class ConsoleMailer implements Mailer {
  /** Last email sent to each address. Tests read this. Keyed by lower-cased `to`. */
  readonly recordedEmails = new Map<string, SendArgs>();

  async send(args: SendArgs): Promise<void> {
    this.recordedEmails.set(args.to.toLowerCase(), args);
    // eslint-disable-next-line no-console
    console.log(
      `\n[mailer:dev] to=${args.to}\n[mailer:dev] subject=${args.subject}\n[mailer:dev] body:\n${args.text}\n`,
    );
  }
}

/**
 * SMTP-backed mailer. Wraps nodemailer's `createTransport`. Lazily
 * connects on first send. Errors surface to the caller; the route is
 * expected to swallow and log so that a bad smtp config never blocks
 * the user-visible "we sent a reset email" response.
 */
export class SmtpMailer implements Mailer {
  private transporter: Transporter | null = null;
  constructor(private readonly config: PlatformConfig) {}

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;
    if (!this.config.smtpHost || !this.config.smtpPort) {
      throw new Error('SmtpMailer: AE_PLATFORM_SMTP_HOST and AE_PLATFORM_SMTP_PORT are required');
    }
    this.transporter = createTransport({
      host: this.config.smtpHost,
      port: this.config.smtpPort,
      secure: this.config.smtpPort === 465,
      auth: this.config.smtpUser
        ? { user: this.config.smtpUser, pass: this.config.smtpPassword ?? '' }
        : undefined,
    });
    return this.transporter;
  }

  async send(args: SendArgs): Promise<void> {
    if (!this.config.smtpFrom) {
      throw new Error('SmtpMailer: AE_PLATFORM_SMTP_FROM is required');
    }
    await this.getTransporter().sendMail({
      from: this.config.smtpFrom,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
  }
}

export function createMailer(config: PlatformConfig): Mailer {
  if (config.emailMode === 'smtp') return new SmtpMailer(config);
  return new ConsoleMailer();
}

// ── Templates ──────────────────────────────────────────────────────────

/** The user clicked "Forgot password." Email contains the recovery token. */
export function recoveryEmail(args: { email: string; token: string; cooldownHours: number }): SendArgs {
  const cooldown = `${args.cooldownHours} hour${args.cooldownHours === 1 ? '' : 's'}`;
  const text = [
    'Someone (hopefully you) asked to reset your Alignment Economy password.',
    '',
    'Open the wallet and paste this recovery token to continue:',
    '',
    args.token,
    '',
    `For your protection, the actual password reset will not be available for ${cooldown}.`,
    'If you did not request this, you can safely ignore this email and nothing will change.',
    '',
    '— The Alignment Economy Foundation',
  ].join('\n');
  return {
    to: args.email,
    subject: 'Reset your Alignment Economy password',
    text,
  };
}

/** Optional verification email used after a successful signup. Currently unused;
 *  wallet may call /verify directly. Kept as a template so wiring it later is one line. */
export function verificationEmail(args: { email: string; token: string }): SendArgs {
  const text = [
    'Welcome to the Alignment Economy.',
    '',
    'Confirm this email address by pasting the following code into the wallet:',
    '',
    args.token,
    '',
    'You can use the wallet without verifying, but unverified accounts cannot recover their password.',
    '',
    '— The Alignment Economy Foundation',
  ].join('\n');
  return {
    to: args.email,
    subject: 'Verify your Alignment Economy email',
    text,
  };
}
