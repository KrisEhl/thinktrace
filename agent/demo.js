// Offline demo: a scripted replay used when API keys are missing.
// Source texts are real Wikipedia excerpts (agent/demo-sources.json) and quotes are
// still checked by the same verifier as live runs. Nothing here calls an API.
import { readFileSync } from 'node:fs';
import { finalizeReport } from './research.js';
import { challengeVerdict } from './factcheck.js';

const CORPUS = JSON.parse(readFileSync(new URL('./demo-sources.json', import.meta.url), 'utf8'));
const [HISTORY, WWW, TBL] = CORPUS;
const INFO = {
  url: 'https://info.cern.ch/',
  title: 'http://info.cern.ch - home of the first website',
  text: 'From here you can: Browse the first website. Browse the first website using the line-mode browser simulator. Learn about the birth of the web. Learn about CERN, the physics laboratory where the web was born.',
};

export const DEMO_QUESTION = 'When did the first website go live, and when did the Web open to the public?';

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });

export async function runDemoResearch(run, emit, signal) {
  const { sources } = run;
  const add = (doc, searchId) => sources.add({ url: doc.url, title: doc.title, content: doc.text.slice(0, 400) }, searchId);
  const read = (src, doc) => {
    src.text = doc.text;
    src.read = true;
    emit('page', { id: src.id, title: src.title, url: src.url, domain: src.domain, excerpt: doc.text.slice(0, 900) });
  };

  emit('status', { phase: 'planning', text: 'Planning the research (offline demo)' });
  await sleep(1200, signal);
  run.plan = {
    subquestions: [
      'When and where was the first website published?',
      'What hardware and software ran it?',
      'When could people outside CERN use the Web?',
      'When did the Web become free for anyone to use?',
    ],
    strategy: 'Anchor on CERN history pages, then cross-check every date against a second independent write-up.',
  };
  emit('plan', { ...run.plan, thinking: '"Go live" and "open to the public" are different events, so dates will likely conflict. Plan for that.' });

  emit('status', { phase: 'researching', text: 'Searching the web' });
  await sleep(1200, signal);
  emit('search', { searchId: 1, query: 'first website info.cern.ch published date', reason: 'Start with the primary event: the first site itself.' });
  await sleep(1100, signal);
  const s1 = [add(HISTORY, 1), add(INFO, 1), add(TBL, 1)];
  emit('results', { searchId: 1, query: 'first website info.cern.ch published date', results: s1.map((s) => sources.public(s)) });
  await sleep(1300, signal);
  emit('thought', { step: 2, text: 'Two encyclopedic sources and the CERN site itself. Read the history page and the biography: they should both carry the date.' });
  emit('read', { ids: [s1[0].id, s1[2].id], reason: 'Snippets mention December 1990; need the exact sentence and context.' });
  await sleep(1500, signal);
  read(s1[0], HISTORY);
  await sleep(500, signal);
  read(s1[2], TBL);
  await sleep(1300, signal);
  emit('thinking', { step: 3, text: 'History page says 20 Dec 1990 for the first site and 6 Aug 1991 for the alt.hypertext post. Is the post the same as "public release"? Need an independent source.' });
  emit('search', { searchId: 2, query: 'World Wide Web released to the public 1991 date', reason: 'Disambiguate "announced" from "released to the whole Internet".' });
  await sleep(1200, signal);
  const s2 = [add(WWW, 2), add(HISTORY, 2)];
  emit('results', { searchId: 2, query: 'World Wide Web released to the public 1991 date', results: s2.map((s) => sources.public(s)) });
  await sleep(1000, signal);
  emit('read', { ids: [s2[0].id], reason: 'Independent article for the public-release date.' });
  await sleep(1300, signal);
  read(s2[0], WWW);
  await sleep(900, signal);
  emit('decision', {
    enough: true,
    reason: 'Each sub-question is covered by at least one read source; the release date differs between sources and is flagged for the writer.',
    gaps: '6 August vs 23 August 1991 for the public release.',
    searches: 2,
    reads: 3,
  });

  emit('status', { phase: 'writing', text: 'Drafting a cited answer' });
  await sleep(1800, signal);
  const id = (doc) => sources.byUrl.get(doc.url).id;
  return finalizeReport(
    run,
    {
      title: 'The first website and the Web going public',
      answer:
        'The first website, info.cern.ch, went live at CERN on 20 December 1990. The Web left CERN in stages: outside servers in January 1991, a public announcement in August 1991, and royalty-free release on 30 April 1993.',
      claims: [
        { text: 'The first website, info.cern.ch, was published on 20 December 1990 and described the Web project itself.', sources: [id(HISTORY), id(TBL)], quote: 'Berners-Lee published the first website, which described the project itself, on 20 December 1990', confidence: 'high' },
        { text: 'A NeXT computer served as the first web server and was also used to write the first browser.', sources: [id(HISTORY)], quote: 'A NeXT Computer was used by Berners-Lee as the web server and also to write the web browser.', confidence: 'medium' },
        { text: 'The first web servers outside CERN were switched on in January 1991.', sources: [id(HISTORY), id(WWW)], quote: 'In January 1991, the first web servers outside CERN were switched on.', confidence: 'high' },
        { text: 'The Web opened to the whole Internet on 6 August 1991.', sources: [id(HISTORY), id(TBL)], quote: 'On 6 August 1991, Berners-Lee published a short summary of the World Wide Web project on the newsgroup alt.hypertext, inviting collaborators.', confidence: 'high' },
        { text: 'CERN made the Web protocol and code available royalty-free on 30 April 1993.', sources: [id(WWW), id(HISTORY)], quote: 'CERN made the Web protocol and code available royalty-free on 30 April 1993, enabling its widespread use.', confidence: 'high' },
        { text: 'Berners-Lee first proposed the system to CERN in March 1989.', sources: [id(WWW), id(TBL)], quote: 'Berners-Lee submitted a proposal to CERN in March 1989, without giving the system a name.', confidence: 'high' },
      ],
      open_questions: ['Which date counts as "public": the alt.hypertext post (6 Aug 1991) or release to the whole Internet (23 Aug 1991)?'],
    },
    emit,
  );
}

const CHECKS = {
  C1: { angle: 'Maybe the server ran earlier, or the date refers to something else.', query: 'info.cern.ch first web page date December 1990', verdict: 'upheld', reasoning: 'Two independent articles give 20 December 1990 for the first website describing the project.', evidence: [['HISTORY', 'the first web site (https://info.cern.ch/) containing the first web pages that described the project itself was published on 20 December 1990', 'supports']] },
  C2: { angle: 'The server and the development machine might have been different computers.', query: 'first web server NeXT computer CERN', verdict: 'upheld', reasoning: 'The history article states the same NeXT machine served both roles; the biography confirms the NeXTSTEP software.', evidence: [['TBL', 'His software also functioned as an editor (called WorldWideWeb, running on the NeXTSTEP operating system)', 'supports']] },
  C3: { angle: 'Outside servers may have come later than January.', query: 'first web server outside CERN 1991', verdict: 'upheld', reasoning: 'Both sources say the technology left CERN to other institutions in January 1991.', evidence: [['WWW', 'The technology was released outside CERN to other research institutions starting in January 1991', 'supports']] },
  C4: { angle: 'An announcement on a newsgroup is not the same as opening to the whole Internet; another source may give a different date.', query: 'World Wide Web released to whole Internet August 1991', verdict: 'weakened', reasoning: 'The cited quote only shows that 6 August 1991 was the alt.hypertext announcement. The World Wide Web article dates the release to the whole Internet to 23 August 1991.', corrected: 'Berners-Lee announced the Web publicly on alt.hypertext on 6 August 1991; it was released to the whole Internet on 23 August 1991.', evidence: [['WWW', 'and then to the whole Internet on 23 August 1991', 'contradicts'], ['HISTORY', 'On 6 August 1991, Berners-Lee published a short summary of the World Wide Web project on the newsgroup alt.hypertext, inviting collaborators.', 'supports']] },
  C5: { angle: 'Maybe only the code, not the protocol, was released; or the date is off.', query: 'CERN 30 April 1993 public domain web', verdict: 'upheld', reasoning: 'Both articles give 30 April 1993; the history page adds that the code went into the public domain.', evidence: [['HISTORY', 'on 30 April 1993, CERN announced that the World Wide Web would be free to anyone, with no fees due, and released their code into the public domain.', 'supports']] },
  C6: { angle: 'The proposal may have been redistributed later, muddying the date.', query: 'Berners-Lee proposal March 1989 Information Management', verdict: 'upheld', reasoning: 'March 1989 holds; the biography notes it was redistributed in 1990, which does not contradict the claim.', evidence: [['TBL', 'Berners-Lee wrote his proposal in March 1989 and redistributed it in 1990.', 'supports']] },
};

export async function demoChallenge(run, claim, emit, signal) {
  const { sources } = run;
  const docs = { HISTORY, WWW, TBL };
  const c = CHECKS[claim.id] ?? CHECKS.C1;
  claim.status = 'checking';
  emit('challenge', { claimId: claim.id, text: claim.text });
  await sleep(1200, signal);
  emit('attack', { claimId: claim.id, angle: c.angle, query: c.query });
  await sleep(1300, signal);
  const found = [...new Set(c.evidence.map(([doc]) => doc))].map((doc) => sources.byUrl.get(docs[doc].url));
  emit('attack_results', { claimId: claim.id, query: c.query, results: found.map((s) => sources.public(s)) });
  await sleep(1600, signal);
  return challengeVerdict(
    run,
    claim,
    {
      verdict: c.verdict,
      reasoning: c.reasoning,
      corrected_claim: c.corrected,
      evidence: c.evidence.map(([doc, quote, stance]) => ({ source: sources.byUrl.get(docs[doc].url).id, quote, stance })),
    },
    emit,
  );
}
