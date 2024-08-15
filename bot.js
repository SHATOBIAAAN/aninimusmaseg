const { Telegraf, Markup, Scenes, session } = require('telegraf')
require('dotenv').config()
const sqlite3 = require('sqlite3').verbose()
process.noDeprecation = true

const bot = new Telegraf(process.env.BOT_TOKEN)
const db = new sqlite3.Database('./chats.db')

// Создание таблиц, если они еще не существуют
db.serialize(() => {
	db.run(`
        CREATE TABLE IF NOT EXISTS scene_state (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            message_id TEXT NOT NULL
        )
    `)

	db.run(`
        CREATE TABLE IF NOT EXISTS chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_chat_id TEXT NOT NULL,
            receiver_chat_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            UNIQUE(sender_chat_id, receiver_chat_id, message_id) -- Уникальное ограничение
        )
    `)
})

// Функция для вставки записи в таблицу
const insertChat = (sender_chat_id, receiver_chat_id, message_id) => {
	return new Promise((resolve, reject) => {
		db.run(
			`INSERT INTO chats (sender_chat_id, receiver_chat_id, message_id) VALUES (?, ?, ?)`,
			[sender_chat_id, receiver_chat_id, message_id],
			function (err) {
				if (err) {
					if (err.code === 'SQLITE_CONSTRAINT') {
						console.log('Запись уже существует, вставка не требуется.')
						resolve() // Запись уже существует
					} else {
						console.error(err.message)
						reject(err)
					}
				} else {
					console.log(`Новый чат сохранен с ID ${this.lastID}`)
					resolve()
				}
			}
		)
	})
}
const newAnswerScene = new Scenes.BaseScene('newAnswerMessage')

newAnswerScene.enter(async ctx => {
	// Извлечение chat_id и message_id из базы данных
	db.get(
		`SELECT chat_id, message_id FROM scene_state ORDER BY id DESC LIMIT 1`,
		[],
		async (err, row) => {
			if (err) {
				console.error('Ошибка при запросе к базе данных:', err.message)
				await ctx.reply('Произошла ошибка при получении состояния сцены.')
				return ctx.scene.leave()
			}

			ctx.scene.state.chat_id = row.chat_id
			ctx.scene.state.message_id = row.message_id

			console.log(
				`answerScene - chat_id: ${ctx.scene.state.chat_id}, message_id: ${ctx.scene.state.message_id}`
			)
			await ctx.reply('Отправь ответ на сообщение:')
		}
	)
})

newAnswerScene.on('message', async ctx => {
	const { message_id, chat_id } = ctx.scene.state
	console.log(`answerScene - chat_id: ${chat_id}, message_id: ${message_id}`)

	if (!chat_id || !message_id) {
		await ctx.reply('Не удалось получить идентификатор чата.')
		return ctx.scene.leave()
	}

	// Получение данных чата из БД
	db.get(
		`SELECT * FROM chats WHERE message_id = ?`,
		[message_id],
		async (err, row) => {
			if (err) {
				console.error('Ошибка при запросе к базе данных:', err.message)
				await ctx.reply('Произошла ошибка при поиске сообщения в базе данных.')
				return ctx.scene.leave()
			}

			const receiver_chat_id = row
				? String(row.sender_chat_id)
				: String(chat_id)
			const sender_chat_id = row
				? String(row.receiver_chat_id)
				: String(chat_id)
			const other_account_chat_id = row
				? String(row.sender_chat_id)
				: String(chat_id) // Используем sender_chat_id из БД
			console.log(
				`receiver_chat_id: ${receiver_chat_id}, sender_chat_id: ${sender_chat_id}, other_account_chat_id: ${other_account_chat_id}`
			)

			try {
				const markup = Markup.inlineKeyboard([
					Markup.button.callback(
						'Ответить🔄',
						`answer_${ctx.chat.id}_${message_id}`
					),
				])
				// Сохранение ответа в БД
				await insertChat(sender_chat_id, sender_chat_id, ctx.message.message_id)
				await bot.telegram.copyMessage(
					sender_chat_id,
					ctx.chat.id,
					ctx.message.message_id,
					markup
				)

				await ctx.reply(
					row
						? 'Ваш ответ был отправлен.'
						: 'Не удалось найти исходное сообщение для ответа.'
				)
			} catch (e) {
				console.error('Ошибка при отправке сообщения:', e.message)
				await ctx.reply('Не удалось отправить ответ этому пользователю.')
			} finally {
				await ctx.scene.leave()
			}
			return ctx.scene.leave()
		}
	)
})

// Функция для удаления кнопок
const removeButtons = async ctx => {
	try {
		await ctx.editMessageReplyMarkup({ inline_keyboard: [] })
	} catch (e) {
		console.error('Ошибка при удалении кнопок:', e.message)
	}
}
// Сцена для получения сообщения
const getMessageScene = new Scenes.BaseScene('getMessage')

getMessageScene.enter(async ctx => {
	const chat_id = ctx.message.text.split(' ')[1]?.trim()
	if (!chat_id) {
		await ctx.reply('Не удалось получить идентификатор чата.')
		return ctx.scene.leave()
	}
	ctx.scene.state.chat_id = chat_id
	await ctx.reply(
		'Отправь сообщение, и его <b>анонимно</b> получит тот пользователь, который поделился с тобой этой ссылкой:',
		{ parse_mode: 'HTML' }
	)
})

getMessageScene.on('message', async ctx => {
	const chat_id = ctx.scene.state.chat_id
	const message_id = ctx.message.message_id

	if (!chat_id) {
		await ctx.reply('Не удалось получить идентификатор чата.')
		return ctx.scene.leave()
	}

	try {
		const markup = Markup.inlineKeyboard([
			Markup.button.callback(
				'Ответить🔄',
				`answer_${ctx.chat.id}_${message_id}`
			),
		])
		await bot.telegram.sendMessage(
			chat_id,
			'💬 Вам пришло новое анонимное сообщение:'
		)
		await bot.telegram.copyMessage(chat_id, ctx.chat.id, message_id, markup)
		// Сохранение данных чата в БД
		await insertChat(ctx.chat.id, chat_id, message_id)
	} catch (e) {
		console.error(e)
		await ctx.reply('Не удалось отправить сообщение этому пользователю.')
	} finally {
		await ctx.reply('Твое <b>анонимное сообщение</b> было доставлено.', {
			parse_mode: 'HTML',
		})
		const me = await bot.telegram.getMe()
		const messageText = `Чтобы получить много анонимных сообщений мы рекомендуем тебе разместить твою персональную ссылку в инстаграме.\n\n📌 Вот твоя персональная ссылка: <code>https://t.me/${me.username}?start=${ctx.from.id}</code>\nНажми на ссылку и она скопируется 👆`

		await bot.telegram.sendAnimation(
			ctx.chat.id,
			{ source: '123.mp4' },
			{ caption: messageText, parse_mode: 'HTML' }
		)
	}
})

// Сцена для ответа на сообщение
const answerScene = new Scenes.BaseScene('answerMessage')

answerScene.enter(async ctx => {
	// Извлечение chat_id и message_id из базы данных
	db.get(
		`SELECT chat_id, message_id FROM scene_state ORDER BY id DESC LIMIT 1`,
		[],
		async (err, row) => {
			if (err) {
				console.error('Ошибка при запросе к базе данных:', err.message)
				await ctx.reply('Произошла ошибка при получении состояния сцены.')
				return ctx.scene.leave()
			}

			ctx.scene.state.chat_id = row.chat_id
			ctx.scene.state.message_id = row.message_id

			console.log(
				`answerScene - chat_id: ${ctx.scene.state.chat_id}, message_id: ${ctx.scene.state.message_id}`
			) // Отладочное сообщение
			await ctx.reply('Отправь ответ на сообщение:')
		}
	)
})

answerScene.on('message', async ctx => {
	const { message_id, chat_id } = ctx.scene.state
	console.log(`answerScene - chat_id: ${chat_id}, message_id: ${message_id}`) // Отладочное сообщение

	if (!chat_id || !message_id) {
		await ctx.reply('Не удалось получить идентификатор чата.')
		return ctx.scene.leave()
	}

	// Получение данных чата из БД
	db.get(
		`SELECT * FROM chats WHERE message_id = ?`,
		[message_id],
		async (err, row) => {
			if (err) {
				console.error('Ошибка при запросе к базе данных:', err.message)
				await ctx.reply('Произошла ошибка при поиске сообщения в базе данных.')
				return ctx.scene.leave()
			}

			const receiver_chat_id = row ? row.sender_chat_id : chat_id
			console.log(`receiver_chat_id: ${receiver_chat_id}`) // Отладочное сообщение

			try {
				const markup = Markup.inlineKeyboard([
					Markup.button.callback(
						'Ответить🔄',
						`backans${ctx.chat.id}_${message_id}`
					),
				])
				// Сохранение ответа в БД
				await insertChat(ctx.chat.id, receiver_chat_id, ctx.message.message_id)
				await bot.telegram.copyMessage(
					receiver_chat_id,
					ctx.chat.id,
					ctx.message.message_id,
					markup
				)

				await ctx.reply(
					row
						? 'Ваш ответ был отправлен.'
						: 'Не удалось найти исходное сообщение для ответа.'
				)
			} catch (e) {
				console.error('Ошибка при отправке сообщения:', e.message)
				await ctx.reply('Не удалось отправить ответ этому пользователю.')
			} finally {
				await ctx.scene.leave()
			}
		}
	)
})

// Настройка сцен и запуск бота
const stage = new Scenes.Stage([getMessageScene, answerScene, newAnswerScene])
bot.use(session())
bot.use(stage.middleware())

bot.start(async ctx => {
	const chat_id = ctx.message.text.split(' ')[1]?.trim()
	console.log(`chat_id: ${chat_id}`)
	const me = await bot.telegram.getMe()

	// Проверка, если пользователь переходит по своей же ссылке
	if (chat_id && chat_id == ctx.from.id) {
		const selfMessage = `🤦‍♀️ Писать самому себе - глупо.\n\nЛучше размести ссылку в сториз или у себя в профиле Instagram/Telegram/VK/TikTok, и сообщения не заставят себя долго ждать 😉`
		await ctx.reply(selfMessage)
		return
	}

	if (!chat_id) {
		const messageText = `Чтобы получить много анонимных сообщений мы рекомендуем тебе разместить твою персональную ссылку в инстаграме.\n\n📌 Вот твоя персональная ссылка: <code>https://t.me/${me.username}?start=${ctx.from.id}</code>\n\nНажми на ссылку и она скопируется 👆`

		// Отправка видео как GIF вместе с текстом
		await bot.telegram.sendAnimation(
			ctx.chat.id,
			{ source: '123.mp4' },
			{ caption: messageText, parse_mode: 'HTML' }
		)

		return
	}

	ctx.scene.state.chat_id = chat_id
	await ctx.scene.enter('getMessage')
})

bot.help(async ctx => {
	const me = await bot.telegram.getMe()
	await ctx.reply(
		`С помощью этого бота вы можете отправить или получить <b>анонимное сообщение</b>.\n\nВот ваша личная ссылка:\n<code>t.me/${me.username}?start=${ctx.chat.id}</code>\nПоделись ею, если хочешь, чтобы тебе отправили <b>анонимное сообщение</b>.`,
		{ parse_mode: 'HTML' }
	)
})

// Обработчик действий для ответа на сообщение
bot.action(/answer_(.+)_(.+)/, async ctx => {
	const [_, chat_id, message_id] = ctx.match
	console.log(`bot.action - chat_id: ${chat_id}, message_id: ${message_id}`) // Отладочное сообщение

	// Сохранение chat_id и message_id в базе данных
	db.run(
		`INSERT INTO scene_state (chat_id, message_id) VALUES (?, ?)`,
		[chat_id, message_id],
		function (err) {
			if (err) {
				console.error(err.message)
			} else {
				console.log(`Состояние сцены сохранено с ID ${this.lastID}`)
			}
		}
	)

	await ctx.scene.enter('answerMessage')
})

// Обработчик действий для обратной отправки сообщения
bot.action(/backans(.+)_(.+)/, async ctx => {
	const [_, chat_id, message_id] = ctx.match
	console.log(`bot.action - chat_id: ${chat_id}, message_id: ${message_id}`)

	// Извлечение sender_chat_id из базы данных
	db.get(
		`SELECT sender_chat_id FROM chats WHERE receiver_chat_id = ? AND message_id = ?`,
		[chat_id, message_id],
		(err, row) => {
			if (err) {
				console.error(err.message)
				return
			}

			if (!row) {
				console.error('Не удалось найти запись с указанным receiver_chat_id.')
				return
			}

			const sender_chat_id = row.sender_chat_id

			// Сохранение sender_chat_id и message_id в базу данных
			db.run(
				`INSERT INTO scene_state (chat_id, message_id) VALUES (?, ?)`,
				[sender_chat_id, message_id],
				function (err) {
					if (err) {
						console.error(err.message)
					} else {
						console.log(`Состояние сцены сохранено с ID ${this.lastID}`)
					}
				}
			)
		}
	)

	await ctx.scene.enter('newAnswerMessage')
	await removeButtons(ctx)
	// Удаление кнопок после нажатия
})

// Запуск бота
bot.launch()
