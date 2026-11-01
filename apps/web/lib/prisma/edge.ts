import { PrismaClient } from "@prisma/client";

/**
 * Prisma client for edge/middleware contexts.
 *
 * Previously this used the @prisma/adapter-planetscale HTTP driver so it
 * could run on Vercel's edge runtime. The self-hosted deployment runs the
 * middleware in the Node.js runtime against PostgreSQL, so a regular
 * PrismaClient is used directly.
 */
export const prismaEdge = new PrismaClient();
