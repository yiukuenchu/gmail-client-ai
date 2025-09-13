import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { GmailSyncService } from "~/server/services/gmail-sync";
import { getFromS3, getPresignedUrl } from "~/server/s3";
import { getGmailClient, getUserRefreshToken } from "~/server/gmail";
import { env } from "~/env";
import { TRPCError } from "@trpc/server";

export const gmailRouter = createTRPCRouter({
  syncMailbox: protectedProcedure
    .mutation(async ({ ctx }) => {
      const syncService = await GmailSyncService.create(ctx.session.user.id);
      if (!syncService) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Gmail not connected. Please reconnect your account.",
        });
      }

      // Start sync in background (in production, use a job queue)
      void syncService.syncMailbox();

      return { success: true, message: "Sync started" };
    }),

  syncBatch: protectedProcedure
    .mutation(async ({ ctx }) => {
      const syncService = await GmailSyncService.create(ctx.session.user.id);
      if (!syncService) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Gmail not connected. Please reconnect your account.",
        });
      }

      try {
        const result = await syncService.syncBatch();
        return result;
      } catch (error) {
        console.error("Batch sync failed:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Sync failed",
        });
      }
    }),

  getSyncStatus: protectedProcedure
    .query(async ({ ctx }) => {
      const user = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: {
          syncStatus: true,
          lastSyncedAt: true,
        },
      });

      const latestJob = await ctx.db.syncJob.findFirst({
        where: { userId: ctx.session.user.id },
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          status: true,
          progress: true,
          totalItems: true,
          processedItems: true,
          error: true,
          startedAt: true,
          completedAt: true,
        },
      });

      return {
        userSyncStatus: user?.syncStatus,
        lastSyncedAt: user?.lastSyncedAt,
        currentJob: latestJob,
      };
    }),

  getThreads: protectedProcedure
    .input(z.object({
      cursor: z.string().optional(),
      limit: z.number().min(1).max(100).default(50),
      labelId: z.string().optional(),
      unreadOnly: z.boolean().default(false),
      search: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      let labelCondition = {};
      
      // Handle special Gmail system labels
      if (input.labelId) {
        switch (input.labelId) {
          case "INBOX":
            labelCondition = {
              labelThreads: {
                some: {
                  label: {
                    gmailLabelId: "INBOX",
                  },
                },
              },
            };
            break;
          case "STARRED":
            labelCondition = { starred: true };
            break;
          case "SENT":
            labelCondition = {
              labelThreads: {
                some: {
                  label: {
                    gmailLabelId: "SENT",
                  },
                },
              },
            };
            break;
          case "DRAFT":
            labelCondition = {
              labelThreads: {
                some: {
                  label: {
                    gmailLabelId: "DRAFT",
                  },
                },
              },
            };
            break;
          case "TRASH":
            labelCondition = {
              labelThreads: {
                some: {
                  label: {
                    gmailLabelId: "TRASH",
                  },
                },
              },
            };
            break;
          default:
            // Custom label by database ID
            labelCondition = {
              labelThreads: {
                some: { labelId: input.labelId },
              },
            };
        }
      }

      const where = {
        userId: ctx.session.user.id,
        ...(input.unreadOnly && { unread: true }),
        ...(input.search && {
          OR: [
            { subject: { contains: input.search, mode: "insensitive" as const } },
            { snippet: { contains: input.search, mode: "insensitive" as const } },
          ],
        }),
        ...labelCondition,
      };

      const threads = await ctx.db.thread.findMany({
        where,
        include: {
          messages: {
            select: {
              from: true,
            },
            orderBy: { date: "desc" },
            take: 1,
          },
          labelThreads: {
            include: {
              label: true,
            },
          },
        },
        orderBy: { lastMessageDate: "desc" },
        take: input.limit + 1,
        ...(input.cursor && {
          cursor: { id: input.cursor },
          skip: 1,
        }),
      });

      let nextCursor: typeof input.cursor | undefined = undefined;
      if (threads.length > input.limit) {
        const nextItem = threads.pop();
        nextCursor = nextItem?.id;
      }

      return {
        threads,
        nextCursor,
      };
    }),

  getThread: protectedProcedure
    .input(z.object({
      threadId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const thread = await ctx.db.thread.findFirst({
        where: {
          id: input.threadId,
          userId: ctx.session.user.id,
        },
        include: {
          messages: {
            include: {
              attachments: true,
            },
            orderBy: { date: "asc" },
          },
          labelThreads: {
            include: {
              label: true,
            },
          },
        },
      });

      if (!thread) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Thread not found",
        });
      }

      // Mark as read
      if (thread.unread) {
        await ctx.db.thread.update({
          where: { id: thread.id },
          data: { unread: false },
        });
      }

      return thread;
    }),

  getMessageContent: protectedProcedure
    .input(z.object({
      messageId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const message = await ctx.db.message.findFirst({
        where: {
          id: input.messageId,
          thread: {
            userId: ctx.session.user.id,
          },
        },
      });

      if (!message) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message not found",
        });
      }

      let htmlContent = null;
      if (message.htmlS3Key) {
        htmlContent = await getFromS3(message.htmlS3Key);
      }

      return {
        html: htmlContent,
        text: message.textContent,
      };
    }),

  getAttachmentUrl: protectedProcedure
    .input(z.object({
      attachmentId: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const attachment = await ctx.db.attachment.findFirst({
        where: {
          id: input.attachmentId,
          message: {
            thread: {
              userId: ctx.session.user.id,
            },
          },
        },
      });

      if (!attachment) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Attachment not found",
        });
      }

      const url = await getPresignedUrl(attachment.s3Key);
      return { url, filename: attachment.filename, mimeType: attachment.mimeType };
    }),

  getLabels: protectedProcedure
    .query(async ({ ctx }) => {
      return await ctx.db.label.findMany({
        where: { userId: ctx.session.user.id },
        orderBy: { name: "asc" },
      });
    }),

  searchThreads: protectedProcedure
    .input(z.object({
      query: z.string().min(1),
      limit: z.number().min(1).max(100).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const threads = await ctx.db.thread.findMany({
        where: {
          userId: ctx.session.user.id,
          OR: [
            { subject: { contains: input.query, mode: "insensitive" } },
            { snippet: { contains: input.query, mode: "insensitive" } },
            {
              messages: {
                some: {
                  from: { contains: input.query, mode: "insensitive" },
                },
              },
            },
          ],
        },
        include: {
          messages: {
            select: {
              from: true,
            },
            orderBy: { date: "desc" },
            take: 1,
          },
        },
        orderBy: { lastMessageDate: "desc" },
        take: input.limit,
      });

      return threads;
    }),

  toggleStar: protectedProcedure
    .input(z.object({
      threadId: z.string(),
      starred: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.thread.update({
        where: {
          id: input.threadId,
          userId: ctx.session.user.id,
        },
        data: {
          starred: input.starred,
        },
      });

      return thread;
    }),

  sendReply: protectedProcedure
    .input(z.object({
      threadId: z.string(),
      to: z.array(z.string()),
      cc: z.array(z.string()).default([]),
      bcc: z.array(z.string()).default([]),
      subject: z.string(),
      content: z.string(),
      attachmentKeys: z.array(z.string()).default([]),
    }))
    .mutation(async ({ ctx, input }) => {
      // Get thread and last message for proper threading
      const thread = await ctx.db.thread.findFirst({
        where: {
          id: input.threadId,
          userId: ctx.session.user.id,
        },
        include: {
          messages: {
            orderBy: { date: "desc" },
            take: 1,
          },
        },
      });

      if (!thread) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Thread not found",
        });
      }

      // Get refresh token
      const refreshToken = await getUserRefreshToken(ctx.session.user.id);
      if (!refreshToken) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Gmail not connected",
        });
      }

      const gmail = getGmailClient(refreshToken);
      const lastMessage = thread.messages[0];
      
      // Build email headers
      const messageId = `<${Date.now()}.${Math.random()}@gmail.com>`;
      const references = lastMessage?.references || [];
      if (lastMessage?.gmailMessageId) {
        references.push(`<${lastMessage.gmailMessageId}>`);
      }

      const currentDate = new Date();
      const subjectText = input.subject || `Re: ${thread.subject}`;

      // 1. OPTIMISTIC UPDATE: Create sent message in database immediately
      const optimisticMessage = await ctx.db.message.create({
        data: {
          threadId: thread.id,
          gmailMessageId: `optimistic-${Date.now()}-${Math.random()}`, // Temporary ID
          gmailThreadId: thread.gmailThreadId,
          from: ctx.session.user.email!,
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: subjectText,
          snippet: input.content.substring(0, 100),
          date: currentDate,
          textContent: input.content,
          inReplyTo: lastMessage?.gmailMessageId || null,
          references: references,
          labelIds: ["SENT"], // Mark as sent immediately
        },
      });

      // 2. Update thread's last message date and increment message count
      await ctx.db.thread.update({
        where: { id: thread.id },
        data: {
          lastMessageDate: currentDate,
          messageCount: { increment: 1 },
        },
      });

      // 3. Ensure SENT label exists and associate with thread
      let sentLabel = await ctx.db.label.findFirst({
        where: {
          userId: ctx.session.user.id,
          gmailLabelId: "SENT",
        },
      });

      if (!sentLabel) {
        sentLabel = await ctx.db.label.create({
          data: {
            userId: ctx.session.user.id,
            gmailLabelId: "SENT",
            name: "Sent",
            type: "SYSTEM",
          },
        });
      }

      // Associate SENT label with thread
      await ctx.db.labelThread.upsert({
        where: {
          labelId_threadId: {
            labelId: sentLabel.id,
            threadId: thread.id,
          },
        },
        create: {
          labelId: sentLabel.id,
          threadId: thread.id,
        },
        update: {},
      });

      try {
        // 4. Send via Gmail API
        const headers = [
          `Message-ID: ${messageId}`,
          `From: ${ctx.session.user.email}`,
          `To: ${input.to.join(", ")}`,
          input.cc.length > 0 ? `Cc: ${input.cc.join(", ")}` : null,
          input.bcc.length > 0 ? `Bcc: ${input.bcc.join(", ")}` : null,
          `Subject: ${subjectText}`,
          lastMessage ? `In-Reply-To: <${lastMessage.gmailMessageId}>` : null,
          references.length > 0 ? `References: ${references.join(" ")}` : null,
          `Content-Type: text/plain; charset=utf-8`,
          `MIME-Version: 1.0`,
        ].filter(Boolean);

        const email = headers.join("\r\n") + "\r\n\r\n" + input.content;
        const encodedMessage = Buffer.from(email, 'utf-8')
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const response = await gmail.users.messages.send({
          userId: "me",
          requestBody: {
            raw: encodedMessage,
            threadId: thread.gmailThreadId,
          },
        });

        // 5. Update optimistic message with real Gmail message ID
        await ctx.db.message.update({
          where: { id: optimisticMessage.id },
          data: {
            gmailMessageId: response.data.id!,
          },
        });

        console.log("Message sent successfully:", {
          optimisticId: optimisticMessage.id,
          gmailId: response.data.id,
          threadId: response.data.threadId,
        });

        return { 
          success: true, 
          messageId: response.data.id,
          optimisticMessage: {
            id: optimisticMessage.id,
            from: optimisticMessage.from,
            to: optimisticMessage.to,
            subject: optimisticMessage.subject,
            date: optimisticMessage.date,
            textContent: optimisticMessage.textContent,
          }
        };

      } catch (error) {
        // 6. ROLLBACK: Remove optimistic updates on send failure
        console.error("Failed to send message, rolling back:", error);
        
        // Remove optimistic message
        await ctx.db.message.delete({
          where: { id: optimisticMessage.id },
        });

        // Revert thread updates
        await ctx.db.thread.update({
          where: { id: thread.id },
          data: {
            lastMessageDate: thread.lastMessageDate,
            messageCount: { decrement: 1 },
          },
        });

        // Remove SENT label association if this was the only sent message
        const otherSentMessages = await ctx.db.message.findFirst({
          where: {
            threadId: thread.id,
            labelIds: { has: "SENT" },
          },
        });

        if (!otherSentMessages) {
          await ctx.db.labelThread.deleteMany({
            where: {
              labelId: sentLabel.id,
              threadId: thread.id,
            },
          });
        }

        throw error;
      }
    }),

  generateAIDraft: protectedProcedure
    .input(z.object({
      threadId: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const thread = await ctx.db.thread.findFirst({
        where: {
          id: input.threadId,
          userId: ctx.session.user.id,
        },
        include: {
          messages: {
            orderBy: { date: "desc" },
            take: 5, // Get last 5 messages for context
          },
        },
      });

      if (!thread) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Thread not found",
        });
      }

      // Build context from thread messages
      const context = thread.messages
        .reverse()
        .map(msg => `From: ${msg.from}\nDate: ${msg.date.toLocaleString()}\n${msg.snippet}`)
        .join("\n\n---\n\n");

      // Generate draft using Gemini
      const { GoogleGenerativeAI } = await import("@google/generative-ai");
      const genAI = new GoogleGenerativeAI(env.GOOGLE_GEMINI_API_KEY || "");
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const prompt = `You are helping to draft a professional email reply. Based on the following email thread, generate a helpful and appropriate reply. Only return the body text of the reply, no subject or headers.

Thread context:
${context}

Generate a professional, concise, and helpful reply:`;

      try {
        const result = await model.generateContent(prompt);
        const draft = result.response.text();

        return { draft };
      } catch (error) {
        console.error("AI generation failed:", error);
        
        // Fallback to a simple template
        return {
          draft: `Thank you for your email. I'll review this and get back to you shortly.\n\nBest regards,\n${ctx.session.user.name || ctx.session.user.email}`,
        };
      }
    }),
});