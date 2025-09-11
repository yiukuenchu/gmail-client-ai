import { google } from "googleapis";
import { type OAuth2Client } from "google-auth-library";
import { db } from "./db";
import { env } from "~/env";

export function getGmailClient(refreshToken: string) {
  const oauth2Client = new google.auth.OAuth2(
    env.AUTH_GOOGLE_ID,
    env.AUTH_GOOGLE_SECRET,
    `${process.env.NEXTAUTH_URL}/api/auth/callback/google`
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export function getOAuth2Client(refreshToken: string): OAuth2Client {
  const oauth2Client = new google.auth.OAuth2(
    env.AUTH_GOOGLE_ID,
    env.AUTH_GOOGLE_SECRET,
    `${process.env.NEXTAUTH_URL}/api/auth/callback/google`
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return oauth2Client;
}

export async function getUserRefreshToken(userId: string): Promise<string | null> {
  const account = await db.account.findFirst({
    where: {
      userId,
      provider: "google",
    },
    select: {
      refresh_token: true,
    },
  });

  return account?.refresh_token ?? null;
}

export interface GmailThread {
  id: string;
  snippet: string;
  historyId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    parts?: Array<{
      mimeType: string;
      body: {
        attachmentId?: string;
        size: number;
        data?: string;
      };
      filename?: string;
      headers?: Array<{ name: string; value: string }>;
      parts?: any[];
    }>;
    body?: {
      size: number;
      data?: string;
    };
    mimeType?: string;
  };
  internalDate: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
  color?: {
    textColor: string;
    backgroundColor: string;
  };
}

export function extractEmailContent(message: GmailMessage): {
  html: string | null;
  text: string | null;
  attachments: Array<{
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
  }>;
} {
  const result = {
    html: null as string | null,
    text: null as string | null,
    attachments: [] as Array<{
      filename: string;
      mimeType: string;
      attachmentId: string;
      size: number;
    }>,
  };

  function processPayloadPart(part: any): void {
    if (!part) return;

    // Handle attachments
    if (part.filename && part.body?.attachmentId) {
      result.attachments.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
        size: part.body.size,
      });
      return;
    }

    // Handle content
    if (part.mimeType === "text/html" && part.body?.data) {
      result.html = Buffer.from(part.body.data, "base64").toString("utf-8");
    } else if (part.mimeType === "text/plain" && part.body?.data) {
      result.text = Buffer.from(part.body.data, "base64").toString("utf-8");
    }

    // Recursively process parts
    if (part.parts) {
      for (const subPart of part.parts) {
        processPayloadPart(subPart);
      }
    }
  }

  // Start processing from the main payload
  if (message.payload.parts) {
    for (const part of message.payload.parts) {
      processPayloadPart(part);
    }
  } else if (message.payload.body?.data) {
    // Simple message with body at root level
    if (message.payload.mimeType === "text/html") {
      result.html = Buffer.from(message.payload.body.data, "base64").toString("utf-8");
    } else if (message.payload.mimeType === "text/plain") {
      result.text = Buffer.from(message.payload.body.data, "base64").toString("utf-8");
    }
  }

  return result;
}

export function getHeaderValue(headers: Array<{ name: string; value: string }>, name: string): string {
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header?.value ?? "";
}

export function parseEmailAddresses(addresses: string): string[] {
  if (!addresses) return [];
  // Simple email parsing - in production, use a proper email parser
  return addresses.split(",").map(addr => addr.trim()).filter(Boolean);
}