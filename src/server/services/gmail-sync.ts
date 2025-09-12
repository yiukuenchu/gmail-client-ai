import { type gmail_v1 } from "googleapis";
import { db } from "../db";
import { 
  getGmailClient, 
  getUserRefreshToken, 
  extractEmailContent, 
  getHeaderValue,
  parseEmailAddresses,
  type GmailThread,
  type GmailMessage,
  type GmailLabel,
} from "../gmail";
import { uploadToS3, S3_PATHS } from "../s3";
import { type JobStatus, type SyncType } from "@prisma/client";

const BATCH_SIZE = 100; // Gmail batch API supports up to 100 requests
const THREADS_PER_PAGE = 500; // Gmail API max
const MAX_CONCURRENT_BATCHES = 8; // Increased for better throughput
const MAX_CONCURRENT_PAGES = 3; // Concurrent page fetching
const DB_BATCH_SIZE = 500; // Bulk database operations

interface SyncMetrics {
  startTime: Date;
  threadsProcessed: number;
  threadsPerMinute: number;
  apiCalls: number;
  dbOperations: number;
}

interface ThreadBatch {
  threads: Array<{ id: string; data?: any }>;
  startIndex: number;
  endIndex: number;
}

export class GmailSyncService {
  private gmail: gmail_v1.Gmail;
  private userId: string;
  private syncJobId: string | null = null;
  private metrics: SyncMetrics;

  constructor(gmail: gmail_v1.Gmail, userId: string) {
    this.gmail = gmail;
    this.userId = userId;
    this.metrics = {
      startTime: new Date(),
      threadsProcessed: 0,
      threadsPerMinute: 0,
      apiCalls: 0,
      dbOperations: 0,
    };
  }

  static async create(userId: string): Promise<GmailSyncService | null> {
    const refreshToken = await getUserRefreshToken(userId);
    if (!refreshToken) return null;

    const gmail = getGmailClient(refreshToken);
    return new GmailSyncService(gmail, userId);
  }

  async syncMailbox(syncType: SyncType = "FULL"): Promise<void> {
    try {
      // Create sync job
      const syncJob = await db.syncJob.create({
        data: {
          userId: this.userId,
          status: "RUNNING",
          type: syncType,
        },
      });
      this.syncJobId = syncJob.id;

      // Update user sync status
      await db.user.update({
        where: { id: this.userId },
        data: { syncStatus: "SYNCING" },
      });

      // Sync labels first
      await this.syncLabels();

      // Sync threads
      await this.syncThreads();

      // Mark sync as completed
      await this.completeSyncJob("COMPLETED");
      
      await db.user.update({
        where: { id: this.userId },
        data: { 
          syncStatus: "COMPLETED",
          lastSyncedAt: new Date(),
        },
      });
    } catch (error) {
      console.error("Sync failed:", error);
      await this.completeSyncJob("FAILED", error instanceof Error ? error.message : "Unknown error");
      
      await db.user.update({
        where: { id: this.userId },
        data: { syncStatus: "FAILED" },
      });
      
      throw error;
    }
  }

  private async completeSyncJob(status: JobStatus, error?: string): Promise<void> {
    if (!this.syncJobId) return;

    await db.syncJob.update({
      where: { id: this.syncJobId },
      data: {
        status,
        completedAt: new Date(),
        progress: status === "COMPLETED" ? 100 : undefined,
        error,
      },
    });
  }

  private async updateSyncProgress(processedItems: number, totalItems: number): Promise<void> {
    if (!this.syncJobId) return;

    const progress = totalItems > 0 ? (processedItems / totalItems) * 100 : 0;
    
    await db.syncJob.update({
      where: { id: this.syncJobId },
      data: {
        processedItems,
        totalItems,
        progress,
      },
    });
  }

  private async syncLabels(): Promise<void> {
    const response = await this.gmail.users.labels.list({ userId: "me" });
    const labels = response.data.labels as GmailLabel[] || [];

    for (const label of labels) {
      await db.label.upsert({
        where: {
          userId_gmailLabelId: {
            userId: this.userId,
            gmailLabelId: label.id,
          },
        },
        update: {
          name: label.name,
          type: label.type === "system" ? "SYSTEM" : "USER",
          color: label.color?.backgroundColor,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
        },
        create: {
          userId: this.userId,
          gmailLabelId: label.id,
          name: label.name,
          type: label.type === "system" ? "SYSTEM" : "USER",
          color: label.color?.backgroundColor,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
        },
      });
    }
  }

  private async syncThreads(): Promise<void> {
    console.log("🚀 Starting optimized thread sync...");
    
    // Phase 1: Fetch all thread IDs with concurrent page fetching
    const allThreadIds = await this.fetchAllThreadIds();
    const totalThreads = allThreadIds.length;
    
    console.log(`📊 Found ${totalThreads} threads to sync`);
    
    if (totalThreads === 0) {
      await this.updateSyncProgress(0, 0);
      return;
    }

    // Phase 2: Process threads in batches using Gmail Batch API
    let processedThreads = 0;
    
    for (let i = 0; i < allThreadIds.length; i += BATCH_SIZE) {
      const batchIds = allThreadIds.slice(i, i + BATCH_SIZE);
      
      try {
        // Fetch thread data using batch API
        const threadDataBatch = await this.fetchThreadsBatch(batchIds);
        
        // Process threads in database batches
        await this.processThreadsBatch(threadDataBatch);
        
        processedThreads += batchIds.length;
        await this.updateSyncProgress(processedThreads, totalThreads);
        
        // Update metrics
        this.updateMetrics(processedThreads);
        
        console.log(`⚡ Processed ${processedThreads}/${totalThreads} threads (${this.metrics.threadsPerMinute.toFixed(1)} threads/min)`);
        
      } catch (error) {
        console.error(`❌ Failed to process batch ${i}-${i + batchIds.length}:`, error);
        // Continue with next batch on error
      }
    }
    
    console.log(`✅ Thread sync completed: ${processedThreads} threads processed`);
  }

  private async fetchAllThreadIds(): Promise<string[]> {
    const allThreadIds: string[] = [];
    const pagePromises: Promise<string[]>[] = [];
    let pageToken: string | undefined;
    let concurrentPages = 0;

    do {
      // Limit concurrent page requests
      if (concurrentPages >= MAX_CONCURRENT_PAGES) {
        const results = await Promise.all(pagePromises);
        results.forEach(threadIds => allThreadIds.push(...threadIds));
        pagePromises.length = 0;
        concurrentPages = 0;
      }

      pagePromises.push(this.fetchThreadPage(pageToken));
      concurrentPages++;

      // Get next page token for the next iteration
      if (pageToken === undefined) {
        const firstPage = await this.gmail.users.threads.list({
          userId: "me",
          maxResults: THREADS_PER_PAGE,
          q: "newer_than:90d", // Optimize for recent emails
        });
        this.metrics.apiCalls++;
        
        pageToken = firstPage.data.nextPageToken ?? undefined;
      } else {
        break; // We'll handle pagination in fetchThreadPage
      }
    } while (pageToken && concurrentPages < MAX_CONCURRENT_PAGES);

    // Process remaining pages
    if (pagePromises.length > 0) {
      const results = await Promise.all(pagePromises);
      results.forEach(threadIds => allThreadIds.push(...threadIds));
    }

    return allThreadIds;
  }

  private async fetchThreadPage(pageToken?: string): Promise<string[]> {
    try {
      const response = await this.gmail.users.threads.list({
        userId: "me",
        maxResults: THREADS_PER_PAGE,
        pageToken,
        q: "newer_than:90d", // Focus on recent emails for better performance
      });
      
      this.metrics.apiCalls++;
      return (response.data.threads || []).map(thread => thread.id!);
    } catch (error) {
      console.error("Failed to fetch thread page:", error);
      return [];
    }
  }

  private async fetchThreadsBatch(threadIds: string[]): Promise<any[]> {
    // Gmail Batch API implementation
    // Note: Gmail API doesn't support true batch requests like other Google APIs
    // So we'll use concurrent individual requests with proper rate limiting
    
    const batchPromises = threadIds.map(async (threadId, index) => {
      try {
        // Add small delay between requests to respect rate limits
        if (index > 0 && index % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        const response = await this.gmail.users.threads.get({
          userId: "me",
          id: threadId,
          format: "full", // Get complete thread data
        });
        
        this.metrics.apiCalls++;
        return { id: threadId, data: response.data, success: true };
      } catch (error) {
        console.error(`Failed to fetch thread ${threadId}:`, error);
        return { id: threadId, data: null, success: false, error };
      }
    });

    return await Promise.all(batchPromises);
  }

  private async processThreadsBatch(threadBatch: any[]): Promise<void> {
    const threadsToInsert: any[] = [];
    const threadsToUpdate: any[] = [];
    const messagesToInsert: any[] = [];
    const attachmentsToInsert: any[] = [];
    const threadLabelAssociations: Array<{ threadId: string; labelIds: string[] }> = [];
    const s3Uploads: Array<{ key: string; content: string; mimeType: string }> = [];

    for (const { id: gmailThreadId, data: threadData, success } of threadBatch) {
      if (!success || !threadData || !threadData.messages || threadData.messages.length === 0) {
        continue;
      }

      try {
        // Extract thread metadata
        const threadInfo = await this.extractThreadMetadata(threadData, gmailThreadId);
        
        // Check if thread exists
        const existingThread = await db.thread.findFirst({
          where: {
            userId: this.userId,
            gmailThreadId: gmailThreadId,
          },
        });

        const threadId = existingThread?.id || gmailThreadId; // Use gmailThreadId temporarily

        if (existingThread) {
          threadsToUpdate.push({
            id: existingThread.id,
            ...threadInfo.threadData,
          });
        } else {
          threadsToInsert.push({
            userId: this.userId,
            gmailThreadId,
            ...threadInfo.threadData,
          });
        }

        // Store label associations for later processing
        threadLabelAssociations.push({
          threadId: threadId,
          labelIds: threadInfo.labelIds,
        });

        // Process messages in this thread
        for (const message of threadData.messages as GmailMessage[]) {
          const messageInfo = await this.extractMessageMetadata(message, existingThread?.id || 'temp');
          messagesToInsert.push(messageInfo.messageData);
          
          // Collect S3 uploads
          if (messageInfo.htmlContent) {
            s3Uploads.push({
              key: S3_PATHS.MESSAGE_HTML(this.userId, message.id),
              content: messageInfo.htmlContent,
              mimeType: "text/html",
            });
          }
          
          // Collect attachments
          if (messageInfo.attachments.length > 0) {
            attachmentsToInsert.push(...messageInfo.attachments);
          }
        }
      } catch (error) {
        console.error(`Failed to process thread ${gmailThreadId}:`, error);
      }
    }

    // Bulk database operations
    await this.performBulkDatabaseOperations({
      threadsToInsert,
      threadsToUpdate,
      messagesToInsert,
      attachmentsToInsert,
      threadLabelAssociations,
    });

    // Background S3 uploads (non-blocking)
    if (s3Uploads.length > 0) {
      this.scheduleS3Uploads(s3Uploads).catch(error => {
        console.error("S3 upload failed:", error);
      });
    }
  }

  private async extractThreadMetadata(threadData: any, gmailThreadId: string) {
    const lastMessage = threadData.messages[threadData.messages.length - 1];
    const firstMessage = threadData.messages[0];
    
    const subject = getHeaderValue(lastMessage.payload.headers, "Subject") || 
                   getHeaderValue(firstMessage.payload.headers, "Subject") || 
                   "(no subject)";
    
    const isUnread = lastMessage.labelIds?.includes("UNREAD") ?? false;
    const isStarred = lastMessage.labelIds?.includes("STARRED") ?? false;
    const isImportant = lastMessage.labelIds?.includes("IMPORTANT") ?? false;

    return {
      threadData: {
        subject,
        snippet: threadData.snippet || "",
        lastMessageDate: new Date(parseInt(lastMessage.internalDate)),
        unread: isUnread,
        starred: isStarred,
        important: isImportant,
        messageCount: threadData.messages.length,
      },
      labelIds: lastMessage.labelIds || [],
    };
  }

  private async extractMessageMetadata(message: any, threadId: string) {
    const headers = message.payload.headers;
    const from = getHeaderValue(headers, "From");
    const to = parseEmailAddresses(getHeaderValue(headers, "To"));
    const cc = parseEmailAddresses(getHeaderValue(headers, "Cc"));
    const bcc = parseEmailAddresses(getHeaderValue(headers, "Bcc"));
    const subject = getHeaderValue(headers, "Subject") || "(no subject)";
    const date = new Date(parseInt(message.internalDate));
    const inReplyTo = getHeaderValue(headers, "In-Reply-To") || null;
    const references = parseEmailAddresses(getHeaderValue(headers, "References"));

    // Extract content
    const { html, text, attachments } = extractEmailContent(message);

    return {
      messageData: {
        threadId,
        gmailMessageId: message.id,
        gmailThreadId: message.threadId,
        from,
        to,
        cc,
        bcc,
        subject,
        snippet: message.snippet,
        date,
        textContent: text,
        inReplyTo,
        references,
        labelIds: message.labelIds || [],
      },
      htmlContent: html,
      attachments: attachments.map((att: any) => ({
        messageId: 'temp', // Will be updated after message insert
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        s3Key: S3_PATHS.ATTACHMENT(this.userId, message.id, att.attachmentId, att.filename),
        gmailAttachmentId: att.attachmentId,
      })),
    };
  }

  private async performBulkDatabaseOperations(data: {
    threadsToInsert: any[];
    threadsToUpdate: any[];
    messagesToInsert: any[];
    attachmentsToInsert: any[];
    threadLabelAssociations: Array<{ threadId: string; labelIds: string[] }>;
  }): Promise<void> {
    try {
      // Use database transaction for consistency
      await db.$transaction(async (tx) => {
        // Bulk insert new threads
        if (data.threadsToInsert.length > 0) {
          await tx.thread.createMany({
            data: data.threadsToInsert,
            skipDuplicates: true,
          });
          this.metrics.dbOperations++;
        }

        // Bulk update existing threads
        for (const thread of data.threadsToUpdate) {
          await tx.thread.update({
            where: { id: thread.id },
            data: thread,
          });
        }
        if (data.threadsToUpdate.length > 0) {
          this.metrics.dbOperations++;
        }

        // Get thread IDs for message insertion
        const threadIdMap = new Map<string, string>();
        if (data.threadsToInsert.length > 0) {
          const insertedThreads = await tx.thread.findMany({
            where: {
              userId: this.userId,
              gmailThreadId: { in: data.threadsToInsert.map(t => t.gmailThreadId) },
            },
            select: { id: true, gmailThreadId: true },
          });
          
          insertedThreads.forEach(thread => {
            threadIdMap.set(thread.gmailThreadId, thread.id);
          });
        }

        // Update messages with correct thread IDs
        const messagesToInsert = data.messagesToInsert.map(msg => ({
          ...msg,
          threadId: threadIdMap.get(msg.gmailThreadId) || msg.threadId,
        }));

        // Bulk insert messages
        if (messagesToInsert.length > 0) {
          await tx.message.createMany({
            data: messagesToInsert,
            skipDuplicates: true,
          });
          this.metrics.dbOperations++;
        }

        // Handle attachments if any
        if (data.attachmentsToInsert.length > 0) {
          // Get message IDs for attachment insertion
          const messageIdMap = new Map<string, string>();
          const insertedMessages = await tx.message.findMany({
            where: {
              gmailMessageId: { in: messagesToInsert.map(m => m.gmailMessageId) },
            },
            select: { id: true, gmailMessageId: true },
          });
          
          insertedMessages.forEach(message => {
            messageIdMap.set(message.gmailMessageId, message.id);
          });

          // Update attachments with correct message IDs
          const attachmentsToInsert = data.attachmentsToInsert.map(att => ({
            ...att,
            messageId: messageIdMap.get(att.gmailMessageId) || att.messageId,
          })).filter(att => att.messageId !== 'temp');

          if (attachmentsToInsert.length > 0) {
            await tx.attachment.createMany({
              data: attachmentsToInsert,
              skipDuplicates: true,
            });
            this.metrics.dbOperations++;
          }
        }

        // Sync thread labels
        if (data.threadLabelAssociations.length > 0) {
          // Update thread ID mapping for label associations
          const finalThreadIdMap = new Map<string, string>(threadIdMap);
          
          // Add existing thread IDs to the map
          for (const thread of data.threadsToUpdate) {
            const t = await tx.thread.findFirst({
              where: { id: thread.id },
              select: { id: true, gmailThreadId: true },
            });
            if (t) {
              finalThreadIdMap.set(t.gmailThreadId, t.id);
            }
          }

          // Process label associations
          for (const { threadId, labelIds } of data.threadLabelAssociations) {
            const actualThreadId = finalThreadIdMap.get(threadId) || threadId;
            
            if (actualThreadId && actualThreadId !== 'temp') {
              // Delete existing label associations
              await tx.labelThread.deleteMany({
                where: { threadId: actualThreadId },
              });

              // Get label IDs from Gmail label IDs
              if (labelIds.length > 0) {
                const labels = await tx.label.findMany({
                  where: {
                    userId: this.userId,
                    gmailLabelId: { in: labelIds },
                  },
                  select: { id: true },
                });

                // Create new label associations
                const labelThreadData = labels.map(label => ({
                  labelId: label.id,
                  threadId: actualThreadId,
                }));

                if (labelThreadData.length > 0) {
                  await tx.labelThread.createMany({
                    data: labelThreadData,
                    skipDuplicates: true,
                  });
                }
              }
            }
          }
          this.metrics.dbOperations++;
        }
      });
    } catch (error) {
      console.error("Bulk database operation failed:", error);
      throw error;
    }
  }

  private async scheduleS3Uploads(uploads: Array<{ key: string; content: string; mimeType: string }>): Promise<void> {
    // Background S3 uploads with concurrency control
    const uploadPromises = uploads.map(async ({ key, content, mimeType }) => {
      try {
        await uploadToS3(key, content, mimeType);
      } catch (error) {
        console.error(`S3 upload failed for ${key}:`, error);
      }
    });

    // Process uploads with limited concurrency
    const batchSize = 10;
    for (let i = 0; i < uploadPromises.length; i += batchSize) {
      const batch = uploadPromises.slice(i, i + batchSize);
      await Promise.all(batch);
    }
  }

  private updateMetrics(threadsProcessed: number): void {
    this.metrics.threadsProcessed = threadsProcessed;
    const elapsedMinutes = (Date.now() - this.metrics.startTime.getTime()) / (1000 * 60);
    this.metrics.threadsPerMinute = elapsedMinutes > 0 ? threadsProcessed / elapsedMinutes : 0;
  }

  private async syncThread(gmailThreadId: string): Promise<void> {
    try {
      // Fetch full thread data
      const response = await this.gmail.users.threads.get({
        userId: "me",
        id: gmailThreadId,
      });

      const threadData = response.data;
      if (!threadData.messages || threadData.messages.length === 0) return;

      // Get thread metadata from the last message
      const lastMessage = threadData.messages[threadData.messages.length - 1] as GmailMessage;
      const firstMessage = threadData.messages[0] as GmailMessage;
      
      const subject = getHeaderValue(lastMessage.payload.headers, "Subject") || 
                     getHeaderValue(firstMessage.payload.headers, "Subject") || 
                     "(no subject)";
      
      // Check for INBOX label to determine if unread
      const hasInbox = lastMessage.labelIds?.includes("INBOX") ?? false;
      const isUnread = lastMessage.labelIds?.includes("UNREAD") ?? false;
      const isStarred = lastMessage.labelIds?.includes("STARRED") ?? false;
      const isImportant = lastMessage.labelIds?.includes("IMPORTANT") ?? false;

      // Upsert thread
      const thread = await db.thread.upsert({
        where: {
          userId_gmailThreadId: {
            userId: this.userId,
            gmailThreadId,
          },
        },
        update: {
          subject,
          snippet: threadData.snippet || "",
          lastMessageDate: new Date(parseInt(lastMessage.internalDate)),
          unread: isUnread,
          starred: isStarred,
          important: isImportant,
          messageCount: threadData.messages.length,
        },
        create: {
          userId: this.userId,
          gmailThreadId,
          subject,
          snippet: threadData.snippet || "",
          lastMessageDate: new Date(parseInt(lastMessage.internalDate)),
          unread: isUnread,
          starred: isStarred,
          important: isImportant,
          messageCount: threadData.messages.length,
        },
      });

      // Sync all messages in the thread
      for (const message of threadData.messages as GmailMessage[]) {
        await this.syncMessage(message, thread.id);
      }

      // Sync thread labels
      await this.syncThreadLabels(thread.id, lastMessage.labelIds || []);
    } catch (error) {
      console.error(`Failed to sync thread ${gmailThreadId}:`, error);
    }
  }

  private async syncMessage(message: GmailMessage, threadId: string): Promise<void> {
    const headers = message.payload.headers;
    const from = getHeaderValue(headers, "From");
    const to = parseEmailAddresses(getHeaderValue(headers, "To"));
    const cc = parseEmailAddresses(getHeaderValue(headers, "Cc"));
    const bcc = parseEmailAddresses(getHeaderValue(headers, "Bcc"));
    const subject = getHeaderValue(headers, "Subject") || "(no subject)";
    const date = new Date(parseInt(message.internalDate));
    const inReplyTo = getHeaderValue(headers, "In-Reply-To") || null;
    const references = parseEmailAddresses(getHeaderValue(headers, "References"));

    // Extract content
    const { html, text, attachments } = extractEmailContent(message);

    // Upload HTML to S3
    let htmlS3Key: string | null = null;
    if (html) {
      htmlS3Key = S3_PATHS.MESSAGE_HTML(this.userId, message.id);
      await uploadToS3(htmlS3Key, html, "text/html");
    }

    // Upsert message
    const savedMessage = await db.message.upsert({
      where: {
        gmailMessageId: message.id,
      },
      update: {
        snippet: message.snippet,
        htmlS3Key,
        textContent: text,
        labelIds: message.labelIds || [],
      },
      create: {
        threadId,
        gmailMessageId: message.id,
        gmailThreadId: message.threadId,
        from,
        to,
        cc,
        bcc,
        subject,
        snippet: message.snippet,
        date,
        htmlS3Key,
        textContent: text,
        inReplyTo,
        references,
        labelIds: message.labelIds || [],
      },
    });

    // Sync attachments
    for (const attachment of attachments) {
      await this.syncAttachment(savedMessage.id, message.id, attachment);
    }
  }

  private async syncAttachment(
    messageId: string, 
    gmailMessageId: string,
    attachment: {
      filename: string;
      mimeType: string;
      attachmentId: string;
      size: number;
    }
  ): Promise<void> {
    // Check if attachment already exists
    const existing = await db.attachment.findFirst({
      where: {
        messageId,
        gmailAttachmentId: attachment.attachmentId,
      },
    });

    if (existing) return;

    // Download attachment
    const response = await this.gmail.users.messages.attachments.get({
      userId: "me",
      messageId: gmailMessageId,
      id: attachment.attachmentId,
    });

    if (!response.data.data) return;

    // Upload to S3
    const s3Key = S3_PATHS.ATTACHMENT(
      this.userId, 
      gmailMessageId, 
      attachment.attachmentId,
      attachment.filename
    );
    
    const attachmentData = Buffer.from(response.data.data, "base64");
    await uploadToS3(s3Key, attachmentData, attachment.mimeType);

    // Save to database
    await db.attachment.create({
      data: {
        messageId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        s3Key,
        gmailAttachmentId: attachment.attachmentId,
      },
    });
  }

  private async syncThreadLabels(threadId: string, labelIds: string[]): Promise<void> {
    // Remove existing label associations
    await db.labelThread.deleteMany({
      where: { threadId },
    });

    // Add new label associations
    const labels = await db.label.findMany({
      where: {
        userId: this.userId,
        gmailLabelId: { in: labelIds },
      },
    });

    for (const label of labels) {
      await db.labelThread.create({
        data: {
          labelId: label.id,
          threadId,
        },
      });
    }
  }
}