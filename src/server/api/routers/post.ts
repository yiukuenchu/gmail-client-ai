import { z } from "zod";

import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";

// Minimal post router to prevent build errors
// This is a placeholder from the T3 template
export const postRouter = createTRPCRouter({
  hello: publicProcedure
    .input(z.object({ text: z.string() }))
    .query(({ input }) => {
      return {
        greeting: `Hello ${input.text}`,
      };
    }),

  create: protectedProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // Placeholder - no actual database model
      return {
        id: "placeholder",
        name: input.name,
        createdAt: new Date(),
        createdById: ctx.session.user.id,
      };
    }),

  getLatest: protectedProcedure.query(async ({ ctx }) => {
    // Return null since we don't have a post model
    return null as { 
      id: string; 
      name: string; 
      createdAt: Date; 
      createdById: string; 
    } | null;
  }),

  getSecretMessage: protectedProcedure.query(() => {
    return "you can now see this secret message!";
  }),
});