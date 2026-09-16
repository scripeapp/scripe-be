import { uploadMulterFileToR2 } from "../utils/storage.util";

export interface StorageUploadResult {
  url: string;
  path: string;
  size: number;
  file_name: string;
  mime_type: string;
}

export class StorageService {
  // supabase parameter accepted but unused — all uploads now go through R2.
  // Kept to avoid cascading changes across the many call sites that pass it.
  constructor(_supabase?: unknown) {}

  /**
   * Uploads a Multer file to R2. The `bucket` parameter is kept for
   * call-site compatibility but is used only as a key prefix in R2.
   */
  // _upsert accepted but unused — R2 PutObjectCommand always overwrites by key.
  async uploadFile(
    bucket: string,
    path: string,
    file: Express.Multer.File,
    _upsert?: boolean,
  ): Promise<StorageUploadResult> {
    const key = `${bucket}/${path}`;
    const url = await uploadMulterFileToR2(file, key);

    return {
      url,
      path: key,
      size: file.size,
      file_name: file.originalname,
      mime_type: file.mimetype,
    };
  }
}

export default StorageService;
