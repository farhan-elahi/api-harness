// Prisma + Drizzle relational branches, on an in-memory program with stand-in client types.
import { test, expect } from "bun:test";
import { Project } from "ts-morph";
import check from "./explicit-columns.ts";

test("explicit-columns: bare findMany/findFirst/select fail; select/columns pass", async () => {
  const p = new Project({ useInMemoryFileSystem: true });
  p.createSourceFile("/src/q.ts", `
declare class PrismaClient { user: { findMany(a?: object): unknown; findFirst(a?: object): unknown } }
declare class BetterSQLite3Database { query: { users: { findMany(a?: object): unknown } }; select(a?: object): unknown }
declare const prisma: PrismaClient; declare const db: BetterSQLite3Database;
prisma.user.findMany();
prisma.user.findFirst({ where: {} });
prisma.user.findMany({ select: { id: true } });
db.query.users.findMany({ columns: { id: true } });
db.query.users.findMany();
db.select();
db.select({ id: 1 });
`);
  const r = await check.run({ dir: "/", files: [], ast: () => p, task: {} });
  expect(r.map((x) => `${x.line}:${x.pass}`)).toEqual(["5:false", "6:false", "7:true", "8:true", "9:false", "10:false", "11:true"]);
});
