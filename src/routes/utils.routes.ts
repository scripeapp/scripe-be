import { Router, Request, Response } from "express";
import { convertToAllCurrencies } from "../utils/currency-rates.util";

const router = Router();

/**
 * GET /api/utils/rates?amount=<ngn_amount>
 * Public — no auth required.
 * Returns the given NGN amount converted to all supported currencies using live FLW rates.
 */
router.get("/rates", async (req: Request, res: Response) => {
  const raw = req.query.amount;
  const baseAmountNGN = raw ? parseFloat(raw as string) : NaN;

  if (!raw || isNaN(baseAmountNGN) || baseAmountNGN <= 0) {
    return res.status(400).json({
      success: false,
      error: "Query param 'amount' must be a positive number (NGN amount)",
    });
  }

  try {
    const rates = await convertToAllCurrencies(baseAmountNGN);
    return res.json({
      success: true,
      data: {
        base: "NGN",
        base_amount: baseAmountNGN,
        rates,
      },
    });
  } catch (error: any) {
    console.error("[GET /api/utils/rates] Error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to fetch exchange rates",
    });
  }
});

export default router;
