import * as restate from "@restatedev/restate-sdk";

/**
 * A mock "triage my inbox" workflow: read Gmail, ask an LLM whether anything is
 * on fire, ping the user on WhatsApp if so.
 *
 * It exists so the scheduler has something realistic to schedule -- the three
 * steps are stubs, not the point of this example.
 */

/** The envelope the scheduler sends on every run. */
type ScheduledRun = {
  userId: string;
  scheduleId: string;
  scheduledFor: string;
  payload?: unknown;
};

type Mail = { from: string; subject: string; body: string };

type Triage = {
  summary: string;
  urgent: boolean;
};

export const inboxTriage = restate.workflow({
  name: "InboxTriage",
  options: {
    // Results and state of a run stay queryable for three days.
    workflowRetention: { days: 3 },
  },
  handlers: {
    run: async (ctx: restate.WorkflowContext, run: ScheduledRun): Promise<Triage> => {
      const mails = await ctx.run("fetch-gmail", () => fetchInbox(run.userId));

      if (mails.length === 0) {
        return { summary: "Nothing new since the last run.", urgent: false };
      }

      const triage = await ctx.run("classify", () => classify(mails), {
        // The LLM leg is flaky and paid for; bound the retries.
        maxRetryAttempts: 4,
        initialRetryInterval: { seconds: 1 },
      });

      if (triage.urgent) {
        await ctx.run("notify-whatsapp", () => sendWhatsApp(run.userId, triage.summary));
      }

      console.log(`[triage] ${run.userId} @ ${run.scheduledFor}: ${triage.summary}`);
      return triage;
    },
  },
});

// ---------------------------------------------------------------------------
// Step 1: Gmail (mocked -- 1 or 2 mails out of a fixed pool)
// ---------------------------------------------------------------------------

const INBOX: Mail[] = [
  { from: "billing@aws.com", subject: "Your invoice is ready", body: "$412.09 for September." },
  { from: "mum", subject: "Sunday lunch?", body: "Are you coming over on Sunday?" },
  { from: "oncall@acme.io", subject: "PagerDuty: production outage", body: "api-gateway is returning 503s." },
  { from: "no-reply@github.com", subject: "3 new pull requests", body: "Review requested on restatedev/sdk." },
  { from: "legal@acme.io", subject: "URGENT: contract expires today", body: "Needs a signature before 18:00." },
  { from: "newsletter@hn.io", subject: "Hacker Newsletter #712", body: "This week in tech." },
  { from: "landlord@flat.de", subject: "Rent overdue", body: "We did not receive this month's payment." },
  { from: "calendar@acme.io", subject: "Reminder: 1:1 tomorrow", body: "With Sarah, 10:00." },
  { from: "friend@gmail.com", subject: "Photos from the trip", body: "Uploaded them to the shared album." },
  { from: "security@bank.de", subject: "Unusual login attempt", body: "Sign-in from an unrecognised device." },
];

function fetchInbox(userId: string): Mail[] {
  const count = 1 + Math.floor(Math.random() * 2);
  const picked = [...INBOX].sort(() => Math.random() - 0.5).slice(0, count);
  console.log(`[gmail] fetched ${picked.length} mail(s) for ${userId}`);
  return picked;
}

// ---------------------------------------------------------------------------
// Step 2: classifier (real LLM if OPENAI_API_KEY is set, mock otherwise)
// ---------------------------------------------------------------------------

const URGENT_WORDS = /urgent|outage|overdue|expires|unusual|asap|deadline/i;

async function classify(mails: Mail[]): Promise<Triage> {
  const apiKey = process.env.OPENAI_API_KEY;
  return apiKey === undefined ? mockClassify(mails) : llmClassify(mails, apiKey);
}

function mockClassify(mails: Mail[]): Triage {
  const urgent = mails.some((m) => URGENT_WORDS.test(`${m.subject} ${m.body}`));
  const subjects = mails.map((m) => `"${m.subject}" (${m.from})`).join(", ");
  return {
    summary: urgent ? `Needs attention: ${subjects}.` : `Nothing pressing: ${subjects}.`,
    urgent,
  };
}

async function llmClassify(mails: Mail[], apiKey: string): Promise<Triage> {
  const inbox = mails.map((m) => `From: ${m.from}\nSubject: ${m.subject}\n${m.body}`).join("\n\n---\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Summarise the inbox in one sentence and decide whether it needs the user's attention " +
            'in the next hour. Reply as JSON: {"summary": string, "urgent": boolean}.',
        },
        { role: "user", content: inbox },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401 || response.status === 400) {
      throw new restate.TerminalError(`OpenAI rejected the request (${response.status}): ${body}`);
    }
    throw new Error(`OpenAI call failed (${response.status}): ${body}`);
  }

  const completion = (await response.json()) as { choices: { message: { content: string } }[] };
  const triage = JSON.parse(completion.choices[0].message.content) as Triage;
  return { summary: triage.summary, urgent: triage.urgent === true };
}

// ---------------------------------------------------------------------------
// Step 3: notifier (mocked -- prints instead of calling WhatsApp)
// ---------------------------------------------------------------------------

function sendWhatsApp(userId: string, summary: string) {
  console.log(`\n💬📱 [whatsapp] 🚨 to ${userId}: ${summary}\n`);
}
