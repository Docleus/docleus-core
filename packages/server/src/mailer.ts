import { createTransport } from "nodemailer";

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Sends instance mail, for example invitations. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export interface SmtpMailerOptions {
  /** An SMTP connection URL, for example `smtps://user:pass@mail.example.com`. */
  readonly url: string;
  /** The `From` address of every message. */
  readonly from: string;
}

/** A {@link Mailer} that sends through SMTP with nodemailer. */
export function createSmtpMailer(options: SmtpMailerOptions): Mailer {
  const transport = createTransport(options.url);
  return {
    async send(message) {
      await transport.sendMail({ from: options.from, ...message });
    },
  };
}
