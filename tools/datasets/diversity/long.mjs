/** Material for LONG messages (DS015 "Long messages"): multi-sentence and multi-paragraph messages of 500 to about
 * 6,000 characters that compose several independently realized parts (statements, hedges, reported speech,
 * questions) with chit-chat, digressions and lists that produce nothing in the target.
 *
 * Chit-chat here is only about the user's own situation, plans or feelings, greetings, apologies and sign-offs:
 * remarks the model does not formalize (DS015 "Stated versus assumed"). It never asserts a relation between named
 * entities, so it cannot hide a missing `stated`. Every string is original project text.
 */

export const CHITCHAT = {
  en: ['Sorry in advance, this is going to be a long one.', 'I hope you are having a good day.', 'It has been a hectic week on my side.', 'I am writing this on my phone, so bear with me.',
    'The weather here has been awful all week.', 'I only have a few minutes before my next call.', 'My coffee went cold while I was typing this.', 'I have been meaning to ask about this for a while.',
    'Honestly, I keep losing track of who does what.', 'Thanks for your patience with all my questions.', 'I will probably forget half of this by tomorrow.', 'Let me give you some background first.',
    'This is mostly for my own notes, to be honest.', 'I tried to sort this out myself but got confused.', 'My manager wants a summary by the end of the day.', 'Anyway, back to what I actually wanted to ask.',
    'Bear with me, I am thinking out loud here.', 'I have a dentist appointment later, so I am in a bit of a rush.', 'We had a power cut this morning, which did not help.', 'I am new to all of this, so apologies if it is obvious.',
    'I will try to keep the rest short.'],
  ro: ['Scuze de la început, mesajul o să fie cam lung.', 'Sper că ai o zi bună.', 'Am avut o săptămână foarte aglomerată.', 'Scriu de pe telefon, așa că te rog să ai răbdare.',
    'Aici a plouat toată săptămâna.', 'Am doar câteva minute până la următorul apel.', 'Mi s-a răcit cafeaua cât am scris asta.', 'Voiam de mult să te întreb asta.',
    'Sincer, nu mai țin minte cine ce face.', 'Mersi că ai răbdare cu toate întrebările mele.', 'Probabil că mâine uit jumătate din ce am scris.', 'Întâi să-ți dau puțin context.',
    'Asta e mai mult pentru notițele mele, sincer.', 'Am încercat să mă lămuresc singur, dar m-am încurcat.', 'Șefa vrea un rezumat până la sfârșitul zilei.', 'Bun, revin la ce voiam de fapt să întreb.',
    'Stai puțin, gândesc cu voce tare.', 'Am programare la dentist mai târziu, deci mă grăbesc.', 'Azi-dimineață s-a luat curentul, ceea ce nu m-a ajutat.', 'Sunt nou în toate astea, scuze dacă e evident.',
    'Încerc să fiu scurt cu restul.'],
};

/** Sign-offs, only at the end of a long message. */
export const SIGNOFFS = {
  en: ['That is all the background I have for now.', 'Thanks a lot, I really appreciate it.', 'Talk soon!', 'Cheers, and have a nice evening.', 'Thanks in advance!'],
  ro: ['Cam ăsta e tot contextul pe care îl am.', 'Mersi mult, chiar apreciez.', 'Vorbim!', 'O seară frumoasă!', 'Mersi anticipat!'],
};

/** Digressions written as a list of the user's own errands (no named entity, no relation to formalize). */
export const LISTS = {
  en: [['Things I still have to do today:', ['buy groceries', 'call the plumber', 'pay the phone bill', 'water the plants', 'finish the slides', 'book the train tickets', 'return the library books', 'answer my emails']]],
  ro: [['Ce mai am de făcut azi:', ['cumpărături', 'să sun instalatorul', 'să plătesc factura la telefon', 'să ud florile', 'să termin prezentarea', 'să iau bilete de tren', 'să răspund la mailuri', 'să duc hainele la curățătorie']]],
};

/** Lead-ins before the questions of a long message. */
export const QUESTION_LEADS = {
  en: ['So, my questions:', 'Now, what I need to know:', 'Here is what I would like to check:', 'A few questions, then:', 'What I actually want to know:', ''],
  ro: ['Deci, întrebările mele:', 'Acum, ce vreau să aflu:', 'Uite ce aș vrea să verific:', 'Câteva întrebări, atunci:', 'Ce vreau de fapt să știu:', ''],
};

/** Target length of a long message in characters: mostly 500–1,500, some up to 3,000, a few up to about 6,000. */
export function lengthTarget(random) {
  const band = random.weighted([['short', 65], ['medium', 28], ['very_long', 7]]);
  if (band === 'short') return 500 + random.int(1000);
  if (band === 'medium') return 1500 + random.int(1500);
  return 3000 + random.int(3000);
}

/** A list digression in `language` with 3–6 items. */
export function listDigression(random, language) {
  const [intro, items] = random.pick(LISTS[language]);
  const pool = [...items];
  const chosen = Array.from({ length: 3 + random.int(4) }, () => pool.splice(random.int(pool.length), 1)[0]).filter(Boolean);
  return `${intro}\n${chosen.map(item => `- ${item}`).join('\n')}`;
}
