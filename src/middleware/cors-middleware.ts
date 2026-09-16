import { Request, Response, NextFunction } from "express";
function corsDebugMiddleware(req: Request, res: Response, next: NextFunction) {
  console.log("Origin:", req.headers.origin);
  console.log("Method:", req.method);
  console.log("Headers:", req.headers);

  res.on("finish", () => {
    console.log("Response headers:", res.getHeaders());
  });

  next();
}

export default corsDebugMiddleware;
