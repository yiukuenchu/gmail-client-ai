import { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  DeleteObjectCommand,
  type PutObjectCommandInput,
  type GetObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "~/env";

export const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

export const S3_PATHS = {
  MESSAGE_HTML: (userId: string, messageId: string) => 
    `users/${userId}/messages/${messageId}/content.html`,
  ATTACHMENT: (userId: string, messageId: string, attachmentId: string, filename: string) => 
    `users/${userId}/messages/${messageId}/attachments/${attachmentId}/${filename}`,
  DRAFT_ATTACHMENT: (userId: string, draftId: string, filename: string) =>
    `users/${userId}/drafts/${draftId}/${filename}`,
} as const;

export async function uploadToS3(
  key: string, 
  body: Buffer | Uint8Array | string,
  contentType: string
): Promise<void> {
  const params: PutObjectCommandInput = {
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  };

  const command = new PutObjectCommand(params);
  await s3Client.send(command);
}

export async function getFromS3(key: string): Promise<string | null> {
  try {
    const params: GetObjectCommandInput = {
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
    };

    const command = new GetObjectCommand(params);
    const response = await s3Client.send(command);
    
    if (!response.Body) return null;
    
    return await response.Body.transformToString();
  } catch (error) {
    console.error("Error fetching from S3:", error);
    return null;
  }
}

export async function getFromS3AsBuffer(key: string): Promise<Buffer | null> {
  try {
    const params: GetObjectCommandInput = {
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
    };

    const command = new GetObjectCommand(params);
    const response = await s3Client.send(command);
    
    if (!response.Body) return null;
    
    const bytes = await response.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (error) {
    console.error("Error fetching from S3:", error);
    return null;
  }
}

export async function deleteFromS3(key: string): Promise<void> {
  const params = {
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
  };

  const command = new DeleteObjectCommand(params);
  await s3Client.send(command);
}

export async function getPresignedUrl(
  key: string, 
  expiresIn: number = 3600
): Promise<string> {
  const params: GetObjectCommandInput = {
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
  };

  const command = new GetObjectCommand(params);
  return await getSignedUrl(s3Client, command, { expiresIn });
}

export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn: number = 3600
): Promise<string> {
  const params: PutObjectCommandInput = {
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  };

  const command = new PutObjectCommand(params);
  return await getSignedUrl(s3Client, command, { expiresIn });
}