const db = new sqlite3.Database('./chats.db')

// Создание таблицы, если она еще не существует
db.run(`
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_chat_id TEXT,
    receiver_chat_id TEXT,
    message_id INTEGER
  )
`)
