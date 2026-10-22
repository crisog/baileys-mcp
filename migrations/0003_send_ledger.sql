create table "send_ledger" ("idempotency_key" text not null primary key, "tool" text not null, "chat_jid" text not null, "message_id" text not null, "outcome" text not null, "created_at" text not null);

create index "send_ledger_created_at_idx" on "send_ledger" ("created_at");
