import type { Principal } from "../db/principal.js";
import type { AuthContext } from "../middleware/auth.js";
import type { DeviceActor } from "../domains/pos/pos.service.js";

declare global {
  namespace Express {
    interface Request {
      auth: AuthContext | null;
      principal: Principal;
      requestId: string;
      /** Set on /api/pos/device/* once the device token resolves. */
      device?: DeviceActor;
    }
  }
}

export {};
