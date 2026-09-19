import type { Principal } from "../db/principal.js";
import type { AuthContext } from "../middleware/auth.js";

declare global {
  namespace Express {
    interface Request {
      auth: AuthContext | null;
      principal: Principal;
      requestId: string;
    }
  }
}

export {};
