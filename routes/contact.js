import express from "express";
import { Resend } from "resend";

const router = express.Router();

const resend = new Resend(process.env.RESEND_API_KEY);

router.post("/", async (req, res) => {
    try {
        const {
            "contact[first_name]": firstName,
            "contact[last_name]": lastName,
            "contact[email]": email,
            "contact[topic]": topic,
            "contact[body]": message,
        } = req.body;

        const fullName = `${firstName || ""} ${lastName || ""}`.trim();

        const html = `
      <div style="font-family: Arial, sans-serif; background:#0f0f0f; color:#fff; padding:20px;">
        <div style="max-width:600px; margin:auto; background:#1a1a1a; border-radius:12px; overflow:hidden;">
          
          <div style="padding:20px; border-bottom:1px solid #333;">
            <h2 style="margin:0; color:#fff;">New Contact Message</h2>
            <p style="color:#aaa; font-size:14px;">Street Fighter Store</p>
          </div>

          <div style="padding:20px;">
            <p><strong>Name:</strong> ${fullName || "N/A"}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Topic:</strong> ${topic || "N/A"}</p>

            <div style="margin-top:20px;">
              <p style="margin-bottom:8px;"><strong>Message:</strong></p>
              <div style="background:#0f0f0f; padding:15px; border-radius:8px; color:#ddd;">
                ${(message || "").replace(/\n/g, "<br>")}
              </div>
            </div>
          </div>

          <div style="padding:15px; border-top:1px solid #333; font-size:12px; color:#777;">
            Sent from your website contact form
          </div>

        </div>
      </div>
    `;

        await resend.emails.send({
            from: "Street Fighter Store <support@notification.streetfighterstore.co.uk>",
            to: "support@streetfighterstore.co.uk",
            subject: `New Contact: ${topic || "General Inquiry"}`,
            reply_to: email,
            html,
        });

        return res.status(200).json({ success: true });

    } catch (error) {
        console.error("Contact form error:", error);
        return res.status(500).json({ success: false });
    }
});

export default router;