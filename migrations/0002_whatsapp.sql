create table "messages" ("chat_jid" text not null, "id" text not null, "timestamp" text not null, "recorded_at" text not null, "message" text not null, "raw" blob not null, "message_secret" blob, primary key ("chat_jid", "id"));

create index "messages_chat_jid_timestamp_idx" on "messages" ("chat_jid", "timestamp");

create index "messages_recorded_at_idx" on "messages" ("recorded_at");

create table "events" ("cursor" integer primary key autoincrement, "at" text not null, "type" text not null, "chat_jid" text, "fact_key" text unique, "payload" text not null);

create index "events_at_idx" on "events" ("at");

create index "events_chat_jid_cursor_idx" on "events" ("chat_jid", "cursor");

create table "lid_map" ("lid_jid" text not null primary key, "phone_jid" text not null);

create index "lid_map_phone_jid_idx" on "lid_map" ("phone_jid");

create table "groups" ("jid" text not null primary key, "name" text);
