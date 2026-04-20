import { runDriver } from "../src/driver";

const postgresUrl = process.env.DATABASE_URL;
const describeIfPostgres = postgresUrl ? describe : describe.skip;

describeIfPostgres("driver: publish", () => {
  it("edit: updates a record end-to-end", () => {
    runDriver({ count: 1 });
  });

  it("create: adds a new record end-to-end", () => {
    runDriver({ count: 1, editCount: 0, createCount: 1 });
  });

  it("delete: removes a record end-to-end", () => {
    runDriver({ count: 1, editCount: 0, deleteCount: 1 });
  });
});
