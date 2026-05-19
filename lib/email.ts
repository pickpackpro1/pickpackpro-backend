import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string | string[];
  subject: string;
  html: string;
}): Promise<void> {
  try {
    await resend.emails.send({
      from: `${process.env.RESEND_FROM_NAME ?? "Pick Pack Pro"} <${process.env.RESEND_FROM_EMAIL}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });
  } catch (err) {
    console.error("[email] Failed to send email:", err);
  }
}
