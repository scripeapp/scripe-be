import multer from "multer";

/**
 * Configure multer to store files in memory as buffers
 */
const storage = multer.memoryStorage();
export const MAX_UPLOAD_FILE_SIZE_MB = 50;

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_FILE_SIZE_MB * 1024 * 1024,
  },
});

export default upload;
