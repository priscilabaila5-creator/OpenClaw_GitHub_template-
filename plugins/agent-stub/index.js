// agent-stub — рабочая зона кандидата в шаблоне OpenClaw editor-agent.
//
// Обвязка проекта не меняется: конфиг, Dockerfile, entrypoint и env-имена остаются
// шаблонными. Здесь реализован только пайплайн агента:
// /draft <тема> -> Tavily -> OpenRouter -> черновик с кнопками;
// "Отклонить" -> /revise <замечание> -> новый черновик;
// "Опубликовать" -> sendMessage в TELEGRAM_CHANNEL_ID.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const sessions = new Map();

const SYSTEM_PROMPT = `Ты редактор Telegram-канала. Нужно написать статью на русском языке.

Правила:
- используй только факты из переданных источников;
- не выдумывай URL, цитаты, цифры и имена;
- обязательно добавь раздел "Источники" со ссылками;
- если источники противоречат друг другу, явно обозначь это;
- учитывай замечание редактора при доработке;
- не создавай небезопасный, мошеннический или вредный контент.

Формат:
1. Заголовок.
2. Лид на 2-3 предложения.
3. Основная часть с проверяемыми фактами.
4. Короткий вывод.
5. Источники.

Длина: 2500-3500 знаков. Тон: ясный, журналистский, без канцелярита.`;

export default definePluginEntry({
  id: "agentstub",
  name: "OpenClaw Editor Agent (template)",
  description: "Editor-agent pipeline implemented inside the template plugin.",
  register(api) {
    api.registerCommand({
      name: "start",
      description: "Запустить бота",
      acceptsArgs: false,
      requireAuth: false,
      handler: () => ({
        text:
          "Пришлите тему командой:\n" +
          "/draft тема статьи\n\n" +
          "Я найду источники, подготовлю черновик и покажу кнопки \"Опубликовать\" / \"Отклонить\". " +
          "После отклонения отправьте замечание командой /revise.",
        continueAgent: false,
      }),
    });

    api.registerCommand({
      name: "demo",
      description: "Демо inline-кнопок из шаблона",
      acceptsArgs: false,
      requireAuth: false,
      handler: () => ({
        text: "Демо inline-кнопок. Нажмите любую кнопку:",
        presentation: buttonPresentation("demo"),
        continueAgent: false,
      }),
    });

    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "demo",
      handler: async (ctx) => {
        const action = ctx?.callback?.payload;
        await ctx.respond.editMessage({
          text: action === "publish" ? "Нажато \"Опубликовать\"." : "Нажато \"Отклонить\".",
        });
        return { handled: true };
      },
    });

    // TODO(кандидат): основной пайплайн агента.
    api.registerCommand({
      name: "draft",
      description: "Подготовить черновик статьи: /draft тема",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const topic = commandText(ctx);
        const userId = senderId(ctx);

        if (!topic) {
          return { text: "Напишите тему после команды: /draft тема статьи", continueAgent: false };
        }

        const result = await prepareDraft(api, { userId, topic });
        if (!result.ok) {
          return { text: result.error, continueAgent: false };
        }

        return draftResponse(result.session);
      },
    });

    api.registerCommand({
      name: "revise",
      description: "Доработать отклонённый черновик: /revise замечание",
      acceptsArgs: true,
      requireAuth: false,
      handler: async (ctx) => {
        const userId = senderId(ctx);
        const feedback = commandText(ctx);
        const previous = sessions.get(userId);

        if (!previous?.awaitingFeedback) {
          return {
            text: "Нет черновика, ожидающего замечание. Сначала подготовьте статью через /draft.",
            continueAgent: false,
          };
        }

        if (!feedback) {
          return { text: "Напишите замечание после команды: /revise что исправить", continueAgent: false };
        }

        const result = await prepareDraft(api, {
          userId,
          topic: previous.topic,
          feedback,
          previousArticle: previous.article,
          previousSources: previous.sources,
        });

        if (!result.ok) {
          return { text: result.error, continueAgent: false };
        }

        return draftResponse(result.session);
      },
    });

    api.on("before_dispatch", async (event) => {
      const text = String(event?.content ?? event?.body ?? "").trim();
      if (!text || text.startsWith("/")) return;

      const userId = String(event?.senderId ?? "unknown");
      const session = sessions.get(userId);

      if (session?.awaitingFeedback) {
        return {
          handled: true,
          text: "Черновик ожидает замечание. Отправьте его командой /revise, чтобы новый черновик снова пришёл с кнопками.",
        };
      }

      return {
        handled: true,
        text: "Для подготовки черновика используйте команду /draft и тему статьи. Например: /draft рынок электромобилей в 2026 году",
      };
    });

    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: "editor",
      handler: async (ctx) => {
        const action = ctx?.callback?.payload;
        const userId = String(ctx?.senderId ?? "unknown");
        const session = sessions.get(userId);

        if (!session?.article) {
          await ctx.respond.editMessage({ text: "Черновик не найден. Подготовьте новый через /draft." });
          return { handled: true };
        }

        if (action === "reject") {
          session.awaitingFeedback = true;
          sessions.set(userId, session);
          await ctx.respond.editMessage({
            text:
              "Черновик отклонён.\n\n" +
              "Отправьте замечание командой:\n" +
              "/revise что нужно исправить",
          });
          return { handled: true };
        }

        if (action === "publish") {
          const guard = validateBeforePublish(session);
          if (!guard.ok) {
            await ctx.respond.editMessage({ text: guard.error });
            return { handled: true };
          }

          const published = await publishToChannel(formatPublication(session));
          if (!published.ok) {
            await ctx.respond.editMessage({ text: published.error });
            return { handled: true };
          }

          session.awaitingFeedback = false;
          session.published = true;
          sessions.set(userId, session);
          await ctx.respond.editMessage({ text: "Опубликовано в канал." });
          return { handled: true };
        }

        await ctx.respond.editMessage({ text: "Неизвестное действие. Подготовьте новый черновик через /draft." });
        return { handled: true };
      },
    });
  },
});

async function prepareDraft(api, { userId, topic, feedback = "", previousArticle = "", previousSources = [] }) {
  const cleanTopic = normalize(topic);
  const cleanFeedback = normalize(feedback);

  const envCheck = validateEnvForDraft();
  if (!envCheck.ok) return envCheck;

  if (!isSafeText(cleanTopic)) {
    return { ok: false, error: "Тема выглядит небезопасной. Выберите нейтральную информационную тему." };
  }

  const sources = cleanFeedback && previousSources.length > 0 ? previousSources : await searchSources(api, cleanTopic);
  if (sources.length === 0) {
    return { ok: false, error: "Tavily не вернул источники. Уточните тему и попробуйте ещё раз." };
  }

  const prompt = buildPrompt({
    topic: cleanTopic,
    sources,
    feedback: cleanFeedback,
    previousArticle,
  });

  const out = await api.runtime.llm.complete({
    messages: [{ role: "user", content: prompt }],
  });
  const article = normalize(out?.text);

  if (!article || article.length < 500) {
    return { ok: false, error: "OpenRouter вернул слишком короткий черновик. Попробуйте уточнить тему." };
  }

  if (!isSafeText(article)) {
    return { ok: false, error: "Черновик не прошёл базовую проверку безопасности." };
  }

  const session = {
    topic: cleanTopic,
    article,
    sources,
    awaitingFeedback: false,
    published: false,
    feedbackHistory: cleanFeedback ? [...(sessions.get(userId)?.feedbackHistory ?? []), cleanFeedback] : [],
  };

  sessions.set(userId, session);
  return { ok: true, session };
}

async function searchSources(api, topic) {
  const { result } = await api.runtime.webSearch.search({ args: { query: topic } });
  const results = Array.isArray(result?.results) ? result.results : [];

  return results
    .map((item) => ({
      title: normalize(item?.title).slice(0, 160),
      url: normalize(item?.url),
      content: normalize(item?.content ?? item?.snippet ?? item?.raw_content).slice(0, 900),
    }))
    .filter((item) => item.title && item.url.startsWith("http"))
    .slice(0, 6);
}

function buildPrompt({ topic, sources, feedback, previousArticle }) {
  const sourceBlock = sources
    .map((source, index) => `${index + 1}. ${source.title}\nURL: ${source.url}\nФрагмент: ${source.content}`)
    .join("\n\n");

  return `${SYSTEM_PROMPT}

Тема: ${topic}

${previousArticle ? `Предыдущий черновик:\n${previousArticle}\n\n` : ""}${feedback ? `Замечание редактора:\n${feedback}\n\n` : ""}Источники:
${sourceBlock}`;
}

function draftResponse(session) {
  return {
    text: formatDraft(session),
    presentation: buttonPresentation("editor"),
    continueAgent: false,
  };
}

function buttonPresentation(namespace) {
  return {
    blocks: [
      {
        type: "buttons",
        buttons: [
          { label: "Опубликовать", value: `${namespace}:publish`, style: "primary" },
          { label: "Отклонить", value: `${namespace}:reject`, style: "danger" },
        ],
      },
    ],
  };
}

function formatDraft(session) {
  return `Черновик по теме: ${session.topic}

${session.article}`;
}

function formatPublication(session) {
  return session.article;
}

function validateBeforePublish(session) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return { ok: false, error: "Не задан TELEGRAM_BOT_TOKEN." };
  }

  if (!process.env.TELEGRAM_CHANNEL_ID) {
    return { ok: false, error: "Не задан TELEGRAM_CHANNEL_ID." };
  }

  if (!session.article || !session.sources?.length) {
    return { ok: false, error: "Нет готового черновика с источниками." };
  }

  const hasKnownLink = session.sources.some((source) => session.article.includes(source.url));
  if (!hasKnownLink) {
    return {
      ok: false,
      error: "В статье нет ссылок на найденные источники. Отклоните черновик и попросите добавить ссылки.",
    };
  }

  if (!isSafeText(session.article)) {
    return { ok: false, error: "Черновик не прошёл базовую проверку безопасности." };
  }

  return { ok: true };
}

async function publishToChannel(article) {
  const chunks = splitForTelegram(article);

  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHANNEL_ID,
        text: chunk,
        disable_web_page_preview: true,
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      return { ok: false, error: `Telegram API error: ${body?.description ?? response.statusText}` };
    }
  }

  return { ok: true };
}

function validateEnvForDraft() {
  if (!process.env.OPENROUTER_API_KEY) {
    return { ok: false, error: "Не задан OPENROUTER_API_KEY." };
  }

  if (!process.env.SEARCH_API_KEY && !process.env.TAVILY_API_KEY) {
    return { ok: false, error: "Не задан SEARCH_API_KEY." };
  }

  return { ok: true };
}

function commandText(ctx) {
  const args = ctx?.args;
  if (Array.isArray(args)) return normalize(args.join(" "));
  return normalize(args ?? ctx?.content ?? ctx?.text ?? "");
}

function senderId(ctx) {
  return String(ctx?.senderId ?? ctx?.message?.from?.id ?? ctx?.from?.id ?? "unknown");
}

function splitForTelegram(text) {
  const clean = normalize(text);
  const limit = 3900;
  if (clean.length <= limit) return [clean];

  const chunks = [];
  let rest = clean;
  while (rest.length > limit) {
    const breakAt = Math.max(rest.lastIndexOf("\n", limit), rest.lastIndexOf(". ", limit), 1200);
    chunks.push(rest.slice(0, breakAt).trim());
    rest = rest.slice(breakAt).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function normalize(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isSafeText(text) {
  const value = normalize(text).toLowerCase();
  const blocked = [
    "как взломать",
    "украсть пароль",
    "изготовить бомбу",
    "купить наркотики",
    "мошенническая схема",
    "персональные данные",
  ];

  return value.length >= 4 && !blocked.some((marker) => value.includes(marker));
}
