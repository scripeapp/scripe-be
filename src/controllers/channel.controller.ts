import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import ChannelService from "../services/channel.service";
import type { ChannelType } from "../types/channel.types";

class ChannelController {
  private getService(req: SupabaseRequest) {
    return new ChannelService(req.supabase);
  }

  private channel(req: SupabaseRequest): ChannelType {
    const ch = req.params.channel;
    if (ch !== "whatsapp" && ch !== "sms") throw new Error("Invalid channel");
    return ch;
  }

  private businessId(req: SupabaseRequest): string {
    const id =
      req.businessId || req.query.business_id || req.body?.business_id;
    if (!id)
      throw Object.assign(new Error("Business context required"), {
        statusCode: 400,
      });
    return String(id);
  }

  private err(res: Response, error: unknown) {
    const channelError = error as {
      statusCode?: number;
      code?: string;
      message?: string;
    };
    return res.status(channelError.statusCode || 500).json({
      success: false,
      error: channelError.code || "CHANNEL_ERROR",
      message: channelError.message || "Internal server error",
    });
  }

  // ── Messages ─────────────────────────────────────────────────────────────────

  getMessages = async (req: SupabaseRequest, res: Response) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const page = typeof req.query.page === "string" ? Number(req.query.page) : 1;
      const perPage =
        typeof req.query.per_page === "string" ? Number(req.query.per_page) : 20;
      const data = await this.getService(req).getMessages(
        this.businessId(req),
        this.channel(req),
        { status, search, page: page || 1, per_page: perPage || 20 },
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  getMessageStats = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).getAggregateStats(
        this.businessId(req),
        this.channel(req),
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  getMessage = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).getMessage(
        this.businessId(req),
        this.channel(req),
        req.params.id,
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  createMessage = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).createMessage(
        this.businessId(req),
        req.user_id!,
        this.channel(req),
        req.body,
      );
      return res.status(201).json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  updateMessage = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).updateMessage(
        this.businessId(req),
        this.channel(req),
        req.params.id,
        req.body,
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  deleteMessage = async (req: SupabaseRequest, res: Response) => {
    try {
      await this.getService(req).deleteMessage(
        this.businessId(req),
        this.channel(req),
        req.params.id,
      );
      return res.json({ success: true, message: "Message deleted" });
    } catch (err) {
      return this.err(res, err);
    }
  };

  sendMessage = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).sendMessage(
        this.businessId(req),
        this.channel(req),
        req.params.id,
        { scheduled_at: req.body?.scheduled_at },
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  estimateMessage = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).estimateMessageCost(
        this.businessId(req),
        this.channel(req),
        req.body,
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  getMessageStat = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).getMessageStats(
        this.businessId(req),
        this.channel(req),
        req.params.id,
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  // ── Templates ─────────────────────────────────────────────────────────────────

  getTemplates = async (req: SupabaseRequest, res: Response) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const category =
        typeof req.query.category === "string" ? req.query.category : undefined;
      const search = typeof req.query.search === "string" ? req.query.search : undefined;
      const data = await this.getService(req).getTemplates(
        this.businessId(req),
        this.channel(req),
        { status, category, search },
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  getTemplate = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).getTemplate(
        this.businessId(req),
        this.channel(req),
        req.params.id,
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  createTemplate = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).createTemplate(
        this.businessId(req),
        req.user_id!,
        this.channel(req),
        req.body,
      );
      return res.status(201).json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  updateTemplate = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).updateTemplate(
        this.businessId(req),
        this.channel(req),
        req.params.id,
        req.body,
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  submitTemplate = async (req: SupabaseRequest, res: Response) => {
    try {
      const data = await this.getService(req).submitTemplate(
        this.businessId(req),
        this.channel(req),
        req.params.id,
      );
      return res.json({ success: true, data });
    } catch (err) {
      return this.err(res, err);
    }
  };

  deleteTemplate = async (req: SupabaseRequest, res: Response) => {
    try {
      await this.getService(req).deleteTemplate(
        this.businessId(req),
        this.channel(req),
        req.params.id,
      );
      return res.json({ success: true, message: "Template deleted" });
    } catch (err) {
      return this.err(res, err);
    }
  };

}

export const channelController = new ChannelController();
