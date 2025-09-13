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

const BATCH_SIZE = 50;
const THREADS_PER_PAGE = 100;
const MAX_CONCURRENT_BATCHES = 5;

export class GmailSyncService {
  private gmail: gmail_v1.Gmail;
  private userId: string;
  private syncJobId: string | null = null;

  constructor(gmail: gmail_v1.Gmail, userId: string) {
    this.gmail = gmail;
    this.userId = userId;
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

      // Update user sync status and show initial progress
      await db.user.update({
        where: { id: this.userId },
        data: { syncStatus: "SYNCING" },
      });

      // Show 1% progress immediately for production visibility
      await this.updateSyncProgress(1, 100);

      // Sync labels first
      await this.syncLabels();
      
      // Show 3% progress after labels
      await this.updateSyncProgress(3, 100);

      // Sync threads
      await this.syncThreads();

      // Mark sync as completed
      console.log("🏁 Marking sync job as completed");
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
      
      // Enhanced error logging for production
      if (error instanceof Error) {
        console.error("Error details:", {
          name: error.name,
          message: error.message,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
          userId: this.userId,
          syncJobId: this.syncJobId,
        });
      }
      
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      await this.completeSyncJob("FAILED", errorMessage);
      
      await db.user.update({
        where: { id: this.userId },
        data: { syncStatus: "FAILED" },
      });
      
      throw error;
    }
  }

  async syncBatch(): Promise<{ completed: boolean; progress: number; processedItems: number; totalItems: number }> {
    const BATCH_SIZE = 20; // Increased for 400+ threads/min target
    const BATCH_TIMEOUT = 30000; // 30 seconds
    const startTime = Date.now();
    
    console.log(`🔄 Starting sync batch (batch size: ${BATCH_SIZE})`);
    
    // Find or create sync job
    let syncJob = await db.syncJob.findFirst({
      where: {
        userId: this.userId,
        status: "RUNNING",
      },
      orderBy: { startedAt: "desc" },
    });

    if (!syncJob) {
      // Start new sync job
      console.log(`📝 Creating new sync job for user ${this.userId}`);
      syncJob = await db.syncJob.create({
        data: {
          userId: this.userId,
          status: "RUNNING",
          type: "FULL",
        },
      });
      
      // Sync labels first for new jobs
      console.log(`🏷️ Syncing labels for new job...`);
      await this.syncLabels();
      console.log(`✅ Labels synced`);
    } else {
      console.log(`📂 Continuing existing sync job ${syncJob.id} (processed: ${syncJob.processedItems})`);
    }

    this.syncJobId = syncJob.id;
    
    // Get next batch of threads
    console.log(`📥 Fetching next batch of ${BATCH_SIZE} threads (pageToken: ${syncJob.nextPageToken ? 'yes' : 'none'})`);
    const threads = await this.getNextThreadBatch(BATCH_SIZE, syncJob.nextPageToken);
    console.log(`📧 Retrieved ${threads.items.length} threads (estimated total: ${threads.resultSizeEstimate})`);
    
    if (threads.items.length === 0) {
      // No more threads, complete the sync
      console.log(`🏁 No more threads to process, completing sync`);
      await this.completeSyncJob("COMPLETED");
      await db.user.update({
        where: { id: this.userId },
        data: { 
          syncStatus: "COMPLETED",
          lastSyncedAt: new Date(),
        },
      });
      
      return {
        completed: true,
        progress: 100,
        processedItems: syncJob.processedItems || 0,
        totalItems: syncJob.totalItems || 0,
      };
    }

    // Process threads with bulk operations for better performance
    console.log(`🚀 Processing ${threads.items.length} threads with bulk operations`);
    const bulkResult = await this.syncThreadsBulk(threads.items);
    const processedInBatch = bulkResult.processedCount;
    
    const elapsed = Date.now() - startTime;
    console.log(`🏁 Bulk batch completed: ${processedInBatch}/${threads.items.length} threads in ${elapsed}ms`);

    // Update progress
    const newProcessedItems = (syncJob.processedItems || 0) + processedInBatch;
    const estimatedTotal = Math.max(threads.resultSizeEstimate || 0, newProcessedItems);
    
    console.log(`💾 Updating sync progress: ${newProcessedItems}/${estimatedTotal} threads processed`);
    await db.syncJob.update({
      where: { id: this.syncJobId },
      data: {
        nextPageToken: threads.nextPageToken,
        processedItems: newProcessedItems,
        totalItems: estimatedTotal,
        progress: estimatedTotal > 0 ? Math.round((newProcessedItems / estimatedTotal) * 100) : 0,
      },
    });

    const progress = estimatedTotal > 0 ? Math.round((newProcessedItems / estimatedTotal) * 100) : 0;
    const totalElapsed = Date.now() - startTime;
    const isCompleted = !threads.nextPageToken;
    
    console.log(`📊 Batch completed: ${processedInBatch} threads processed in ${totalElapsed}ms (${progress}% total progress)`);
    
    // If this is the final batch (no more pageToken), complete the sync
    if (isCompleted) {
      console.log(`🏁 Final batch completed, completing sync job`);
      await this.completeSyncJob("COMPLETED");
      await db.user.update({
        where: { id: this.userId },
        data: { 
          syncStatus: "COMPLETED",
          lastSyncedAt: new Date(),
        },
      });
    }
    
    return {
      completed: isCompleted,
      progress: Math.min(progress, 100),
      processedItems: newProcessedItems,
      totalItems: estimatedTotal,
    };
  }

  private async getNextThreadBatch(batchSize: number, pageToken?: string | null) {
    const response = await this.gmail.users.threads.list({
      userId: "me",
      maxResults: batchSize,
      pageToken: pageToken || undefined,
    });

    return {
      items: response.data.threads || [],
      nextPageToken: response.data.nextPageToken || null,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
    };
  }

  private async syncThreadsBulk(threadItems: any[]): Promise<{ processedCount: number }> {
    console.log(`📥 Fetching ${threadItems.length} threads from Gmail API in parallel`);
    
    // Step 1: Fetch all thread data in parallel
    const threadPromises = threadItems.map(async (threadItem) => {
      try {
        const response = await this.gmail.users.threads.get({
          userId: "me",
          id: threadItem.id!,
        });
        return response.data;
      } catch (error) {
        console.error(`Failed to fetch thread ${threadItem.id}:`, error);
        return null;
      }
    });

    const threadDataResults = await Promise.all(threadPromises);
    const validThreads = threadDataResults.filter((thread): thread is NonNullable<typeof thread> => 
      thread !== null && thread !== undefined
    );
    
    console.log(`✅ Fetched ${validThreads.length}/${threadItems.length} threads from Gmail API`);

    // Step 2: Prepare bulk data
    const threadsToCreate = [];
    const messagesToCreate = [];
    const attachmentsToProcess = [];
    const s3UploadTasks = [];

    for (const threadData of validThreads) {
      if (!threadData.messages || threadData.messages.length === 0) continue;

      const messages = threadData.messages as GmailMessage[];
      const lastMessage = messages[messages.length - 1];
      const firstMessage = messages[0];
      
      if (!lastMessage || !firstMessage) continue; // Skip if no valid messages
      
      const subject = getHeaderValue(lastMessage.payload?.headers, "Subject") || 
                     getHeaderValue(firstMessage.payload?.headers, "Subject") || 
                     "(no subject)";

      const isUnread = lastMessage.labelIds?.includes("UNREAD") ?? false;
      const isStarred = lastMessage.labelIds?.includes("STARRED") ?? false;
      const isImportant = lastMessage.labelIds?.includes("IMPORTANT") ?? false;

      // Prepare thread data
      threadsToCreate.push({
        userId: this.userId,
        gmailThreadId: threadData.id!,
        subject,
        snippet: threadData.snippet || "",
        lastMessageDate: new Date(parseInt(lastMessage.internalDate || "0")),
        unread: isUnread,
        starred: isStarred,
        important: isImportant,
        messageCount: messages.length,
      });

      // Prepare message data
      for (const message of messages) {
        if (!message.payload?.headers || !message.id) continue; // Skip invalid messages
        
        const headers = message.payload.headers;
        const from = getHeaderValue(headers, "From");
        const to = parseEmailAddresses(getHeaderValue(headers, "To"));
        const cc = parseEmailAddresses(getHeaderValue(headers, "Cc"));
        const bcc = parseEmailAddresses(getHeaderValue(headers, "Bcc"));
        const messageSubject = getHeaderValue(headers, "Subject") || "(no subject)";
        const date = new Date(parseInt(message.internalDate || "0"));
        const inReplyTo = getHeaderValue(headers, "In-Reply-To") || null;
        const references = parseEmailAddresses(getHeaderValue(headers, "References"));

        // Extract content including attachments
        const { html, text, attachments } = extractEmailContent(message);

        // Prepare S3 upload task
        let htmlS3Key: string | null = null;
        if (html) {
          htmlS3Key = S3_PATHS.MESSAGE_HTML(this.userId, message.id);
          s3UploadTasks.push({
            key: htmlS3Key,
            content: html,
            contentType: "text/html",
          });
        }

        const messageData = {
          gmailMessageId: message.id,
          gmailThreadId: message.threadId,
          from,
          to,
          cc,
          bcc,
          subject: messageSubject,
          snippet: message.snippet,
          date,
          htmlS3Key,
          textContent: text,
          inReplyTo,
          references,
          labelIds: message.labelIds || [],
        };

        messagesToCreate.push(messageData);

        // Collect attachments for processing
        for (const attachment of attachments) {
          attachmentsToProcess.push({
            gmailMessageId: message.id,
            attachment,
          });
        }
      }
    }

    console.log(`📊 Prepared ${threadsToCreate.length} threads, ${messagesToCreate.length} messages, and ${attachmentsToProcess.length} attachments for bulk processing`);

    // Step 3: Bulk database operations
    const bulkStart = Date.now();
    
    // Insert threads with upsert behavior
    const createdThreads = [];
    for (const threadData of threadsToCreate) {
      const thread = await db.thread.upsert({
        where: {
          userId_gmailThreadId: {
            userId: threadData.userId,
            gmailThreadId: threadData.gmailThreadId,
          },
        },
        update: {
          subject: threadData.subject,
          snippet: threadData.snippet,
          lastMessageDate: threadData.lastMessageDate,
          unread: threadData.unread,
          starred: threadData.starred,
          important: threadData.important,
          messageCount: threadData.messageCount,
        },
        create: threadData,
      });
      createdThreads.push(thread);
    }

    // Map thread IDs for messages
    const threadIdMap = new Map();
    for (let i = 0; i < validThreads.length; i++) {
      const validThread = validThreads[i];
      const createdThread = createdThreads[i];
      if (validThread?.id && createdThread?.id) {
        threadIdMap.set(validThread.id, createdThread.id);
      }
    }

    // Add thread IDs to messages
    const messagesWithThreadIds = messagesToCreate.map(msg => ({
      ...msg,
      threadId: threadIdMap.get(msg.gmailThreadId),
    }));

    // Bulk insert messages (will skip duplicates)
    try {
      await db.message.createMany({
        data: messagesWithThreadIds,
        skipDuplicates: true,
      });
    } catch (error) {
      console.log("Some messages already exist, continuing...");
    }

    const bulkTime = Date.now() - bulkStart;
    console.log(`💾 Bulk database operations completed in ${bulkTime}ms`);

    // Step 4: Process attachments
    if (attachmentsToProcess.length > 0) {
      console.log(`📎 Processing ${attachmentsToProcess.length} attachments`);
      
      // Get message IDs for attachments
      const messageIdMap = new Map();
      const createdMessages = await db.message.findMany({
        where: {
          gmailMessageId: { in: messagesToCreate.map(m => m.gmailMessageId) },
        },
        select: { id: true, gmailMessageId: true },
      });
      
      for (const msg of createdMessages) {
        messageIdMap.set(msg.gmailMessageId, msg.id);
      }

      // Process attachments in smaller batches to avoid overwhelming Gmail API
      const ATTACHMENT_BATCH_SIZE = 5;
      for (let i = 0; i < attachmentsToProcess.length; i += ATTACHMENT_BATCH_SIZE) {
        const batch = attachmentsToProcess.slice(i, i + ATTACHMENT_BATCH_SIZE);
        
        await Promise.all(batch.map(async (item) => {
          const messageId = messageIdMap.get(item.gmailMessageId);
          if (messageId) {
            try {
              await this.syncAttachment(messageId, item.gmailMessageId, item.attachment);
            } catch (error) {
              console.error(`Failed to sync attachment for message ${item.gmailMessageId}:`, error);
            }
          }
        }));
      }
      
      console.log(`✅ Attachments processing completed`);
    }

    // Step 5: Bulk sync thread labels (needed for Inbox filtering)
    console.log(`🏷️ Bulk syncing thread labels for ${createdThreads.length} threads`);
    await this.syncThreadLabelsBulk(validThreads, createdThreads);
    console.log(`✅ Thread labels synced`);

    // Step 6: Batch S3 uploads
    if (s3UploadTasks.length > 0) {
      console.log(`☁️ Starting ${s3UploadTasks.length} S3 uploads in batches`);
      const S3_BATCH_SIZE = 10;
      
      for (let i = 0; i < s3UploadTasks.length; i += S3_BATCH_SIZE) {
        const batch = s3UploadTasks.slice(i, i + S3_BATCH_SIZE);
        const uploadPromises = batch.map(task => 
          uploadToS3(task.key, task.content, task.contentType).catch(error => {
            console.error(`S3 upload failed for ${task.key}:`, error);
          })
        );
        await Promise.all(uploadPromises);
      }
      
      console.log(`☁️ S3 uploads completed`);
    }

    return { processedCount: validThreads.length };
  }

  private async syncThreadLabelsBulk(validThreads: any[], createdThreads: any[]): Promise<void> {
    // Step 1: Collect all thread IDs and their label data
    const threadLabelData: Array<{ threadId: string; labelIds: string[] }> = [];
    const allThreadIds: string[] = [];

    for (let i = 0; i < validThreads.length; i++) {
      const threadData = validThreads[i];
      const thread = createdThreads[i];
      
      if (threadData?.messages && threadData.messages.length > 0 && thread?.id) {
        const lastMessage = threadData.messages[threadData.messages.length - 1] as GmailMessage;
        const labelIds = lastMessage?.labelIds || [];
        
        threadLabelData.push({
          threadId: thread.id,
          labelIds: labelIds,
        });
        allThreadIds.push(thread.id);
      }
    }

    if (threadLabelData.length === 0) return;

    // Step 2: Bulk delete existing label associations
    console.log(`🗑️ Removing existing label associations for ${allThreadIds.length} threads`);
    await db.labelThread.deleteMany({
      where: {
        threadId: { in: allThreadIds },
      },
    });

    // Step 3: Get all unique Gmail label IDs and fetch corresponding database labels
    const allLabelIds = [...new Set(threadLabelData.flatMap(item => item.labelIds))];
    console.log(`📋 Looking up ${allLabelIds.length} unique labels`);
    
    const labels = await db.label.findMany({
      where: {
        userId: this.userId,
        gmailLabelId: { in: allLabelIds },
      },
      select: { id: true, gmailLabelId: true },
    });

    // Create a map for quick label lookup
    const labelMap = new Map(labels.map(label => [label.gmailLabelId, label.id]));

    // Step 4: Prepare bulk labelThread data
    const labelThreadsToCreate: Array<{ labelId: string; threadId: string }> = [];
    
    for (const threadData of threadLabelData) {
      for (const gmailLabelId of threadData.labelIds) {
        const labelId = labelMap.get(gmailLabelId);
        if (labelId) {
          labelThreadsToCreate.push({
            labelId: labelId,
            threadId: threadData.threadId,
          });
        }
      }
    }

    // Step 5: Bulk create label-thread associations
    if (labelThreadsToCreate.length > 0) {
      console.log(`🔗 Creating ${labelThreadsToCreate.length} label-thread associations`);
      await db.labelThread.createMany({
        data: labelThreadsToCreate,
        skipDuplicates: true,
      });
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

    // Fix: Ensure progress never exceeds 100% and handle estimates
    const actualTotal = Math.max(totalItems, processedItems); // Use actual count if estimate is wrong
    const progress = actualTotal > 0 ? Math.min((processedItems / actualTotal) * 100, 100) : 0;
    
    await db.syncJob.update({
      where: { id: this.syncJobId },
      data: {
        processedItems,
        totalItems: actualTotal, // Update with actual total
        progress: Math.round(progress), // Round to avoid decimals
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
    let pageToken: string | undefined;
    let totalThreads = 0;
    let processedThreads = 0;
    const startTime = Date.now();
    const PRODUCTION_TIMEOUT = 280000; // 280 seconds - safe margin for 300s Vercel limit

    console.log("🔄 Starting thread sync...");

    do {
      // Check timeout before each page (only in production)
      if (process.env.NODE_ENV === 'production') {
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > PRODUCTION_TIMEOUT) {
          console.log(`⏰ PRODUCTION TIMEOUT: Processed ${processedThreads}/${totalThreads} threads in ${elapsedTime}ms`);
          console.log(`💾 Saving progress and exiting gracefully`);
          return; // Exit gracefully before Vercel kills us
        }
      }

      // Fetch threads page
      const response = await this.gmail.users.threads.list({
        userId: "me",
        maxResults: THREADS_PER_PAGE,
        pageToken,
      });

      const threads = response.data.threads || [];
      // Update total with actual count as we discover more threads
      const currentEstimate = response.data.resultSizeEstimate || 0;
      totalThreads = Math.max(totalThreads, currentEstimate, processedThreads + threads.length);
      
      console.log(`📧 Processing page: ${threads.length} threads (total estimate: ${totalThreads}, processed: ${processedThreads})`);
      
      // Process threads in batches
      for (let i = 0; i < threads.length; i += BATCH_SIZE) {
        const batch = threads.slice(i, i + BATCH_SIZE);
        
        // Process batch concurrently
        await Promise.all(
          batch.map(thread => this.syncThread(thread.id!))
        );
        
        processedThreads += batch.length;
        await this.updateSyncProgress(processedThreads, totalThreads);
        
        // Log progress more frequently for debugging
        if (processedThreads % 10 === 0 || processedThreads === totalThreads) {
          const elapsedTime = Date.now() - startTime;
          console.log(`⚡ Processed ${processedThreads}/${totalThreads} threads (${Math.round(elapsedTime/1000)}s elapsed)`);
        }
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);
    
    const totalElapsed = Date.now() - startTime;
    console.log(`✅ Thread sync completed: ${processedThreads} threads processed in ${Math.round(totalElapsed/1000)}s`);
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

      // Sync all messages in the thread including attachments
      for (const message of threadData.messages as GmailMessage[]) {
        await this.syncMessage(message, thread.id, false); // skipAttachments = false
      }

      // Sync thread labels
      await this.syncThreadLabels(thread.id, lastMessage.labelIds || []);
    } catch (error) {
      console.error(`Failed to sync thread ${gmailThreadId}:`, error);
      // Re-throw to stop sync on critical errors
      if (error instanceof Error && error.message.includes('connection')) {
        throw error;
      }
    }
  }

  private async syncMessage(message: GmailMessage, threadId: string, skipAttachments = false): Promise<void> {
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

    // Sync attachments (skip for initial sync speed)
    if (!skipAttachments) {
      for (const attachment of attachments) {
        await this.syncAttachment(savedMessage.id, message.id, attachment);
      }
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