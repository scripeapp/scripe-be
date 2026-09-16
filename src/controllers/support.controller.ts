import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { emailService } from "../services/email.service";
import { FeatureRequestSchema } from "../types/support.schemas";
import { z } from "zod";

export const submitFeatureRequest = async (req: SupabaseRequest, res: Response) => {
  try {
    const { category, urgency, title, description } = req.body as z.infer<typeof FeatureRequestSchema>;
    const user = (req as any).user;
    
    if (!user) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const userEmail = user.email;
    const userId = user.id;
    // Try to get name from user_metadata or userProfile if available
    const userName = user.user_metadata?.full_name || user.user_metadata?.name || (req as any).userProfile?.name || "Unknown User";

    const emailBody = `
      <h2>Feature Request Received</h2>
      <p><strong>Title:</strong> ${title}</p>
      <p><strong>Category:</strong> ${category}</p>
      <p><strong>Urgency:</strong> ${urgency}</p>
      <hr />
      <h3>Description</h3>
      <p>${description.replace(/\n/g, "<br>")}</p>
      <hr />
      <h3>Submitted By</h3>
      <p><strong>Name:</strong> ${userName}</p>
      <p><strong>Email:</strong> ${userEmail}</p>
      <p><strong>User ID:</strong> ${userId}</p>
    `;

    await emailService.send({
      to: "support@hilaq.com",
      subject: `[Feature Request] - ${title}`,
      body: emailBody,
      type: "platform",
    });

    return res.status(200).json({ success: true, message: "Request received" });
  } catch (error: any) {
    console.error("Error submitting feature request:", error);
    return res.status(500).json({
      success: false,
      error: "INTERNAL_SERVER_ERROR",
      message: "Failed to submit feature request",
    });
  }
};
