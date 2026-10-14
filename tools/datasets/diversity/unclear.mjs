/** Generators of messages the model marks `unclear`, one per kind of sop/unclear.mjs (DS014): `gibberish`
 * (unintelligible text) and `no_request` (no statement or question: greetings, thanks, acknowledgements,
 * unrelated requests such as "write a poem"). Each method composes original material in EN, RO or both;
 * noise (typos, missing diacritics) is added by the builder like for any other row.
 */

const KEY_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const SYLLABLES = ['bla', 'zor', 'ke', 'mif', 'tru', 'nap', 'ost', 'vri', 'lu', 'dex', 'gam', 'pof', 'sni', 'ra', 'quo', 'ult', 'bez', 'jia', 'ția', 'șor'];

function keyboardMash(random) {
  const row = random.pick(KEY_ROWS);
  const start = random.int(row.length - 3);
  const run = row.slice(start, start + 3 + random.int(Math.min(5, row.length - start - 3) + 1));
  return random.chance(0.5) ? run : run + random.pick(['', ' ', 'k', 'j']) + run.slice(0, 2 + random.int(3));
}
const pseudoWord = random => Array.from({ length: 2 + random.int(3) }, () => random.pick(SYLLABLES)).join('');

export const GIBBERISH = [
  { method: 'keyboard_mash', make: random => Array.from({ length: 1 + random.int(3) }, () => keyboardMash(random)).join(' ') },
  { method: 'pseudo_words', make: random => `${pseudoWord(random)} ${pseudoWord(random)} ${pseudoWord(random)}${random.pick(['?', '', '!!', ' ?'])}` },
  { method: 'mash_with_punctuation', make: random => `${keyboardMash(random)}${random.pick(['???', '..', '?!', ';;'])} ${keyboardMash(random)}` },
  { method: 'repeated_letters', make: random => `${random.pick(['a', 'm', 'h', 'e', 'o'])}`.repeat(4 + random.int(8)) + random.pick(['', '?', ' hmm']) },
  { method: 'syllable_soup', make: random => Array.from({ length: 3 + random.int(4) }, () => random.pick(SYLLABLES)).join(random.pick([' ', ' ', '  '])) + random.pick(['', '?', '...']) },
];

const GREETINGS = { en: ['Hi', 'Hello', 'Hey there', 'Good morning', 'Good evening', 'Thanks a lot', 'Thank you', 'Cheers', 'Ok', 'Okay, got it', 'Nice', 'Haha', 'lol', 'Great, thanks'], ro: ['Salut', 'Bună ziua', 'Bună dimineața', 'Bună seara', 'Mersi mult', 'Mulțumesc', 'Ok', 'Am înțeles', 'Super', 'Haha', 'Perfect, mersi', 'Gata'] };
const PHATIC = { en: ['that\'s all for now', 'have a nice day', 'I\'m a bit tired today', 'nice weather today', 'talk later', 'no worries', 'this is fun', 'I was just testing'], ro: ['asta e tot deocamdată', 'o zi bună', 'sunt cam obosit azi', 'e vreme frumoasă azi', 'vorbim mai târziu', 'nicio problemă', 'e amuzant', 'doar testam'] };

/** Phatic talk, thanks, acknowledgements: no statement and no question (`no_request`). */
export const NOT_A_QUESTION = [
  { method: 'greeting', make: (random, language) => `${random.pick(GREETINGS[language])}${random.pick(['!', '.', '', ' :)'])}` },
  { method: 'greeting_and_phatic', make: (random, language) => `${random.pick(GREETINGS[language])}, ${random.pick(PHATIC[language])}${random.pick(['.', '!', ''])}` },
  { method: 'acknowledgement', make: (random, language) => language === 'ro' ? random.pick(['Ok, am notat.', 'Bine.', 'Da, înțeleg.', 'Mhm.', 'Aha, ok.']) : random.pick(['Ok, noted.', 'Fine.', 'Yes, I see.', 'Mhm.', 'Right, ok.']) },
];

const OFF_TOPIC = { en: ['Write me a short poem about autumn.', 'Translate "good morning" into Japanese.', 'Recommend a good film for tonight.', 'Tell me a joke.', 'Summarize the plot of Hamlet for me.', 'Help me write a birthday message for my sister.', 'Draft an email to my landlord about the heating.', 'Make up a name for my new cat.', 'Write a haiku about coffee.', 'Give me a recipe with lentils.', 'Compose a limerick about Mondays.', 'Suggest a few team-building games.',
    // Booking and action requests (C12): no checkable statement or question.
    'Book me a table for two at eight tonight.', 'Please reserve a meeting room for Thursday morning.', 'Order me a taxi to the airport for tomorrow at six.', 'Set a reminder to call the dentist on Monday.'],
  ro: ['Scrie-mi o poezie despre toamnă.', 'Tradu „bună dimineața” în japoneză.', 'Recomandă-mi un film pentru diseară.', 'Spune-mi un banc.', 'Rezumă-mi pe scurt Hamlet.', 'Ajută-mă să scriu o felicitare pentru sora mea.', 'Scrie un e-mail către proprietar despre căldură.', 'Inventează un nume pentru pisica mea.', 'Scrie un haiku despre cafea.', 'Dă-mi o rețetă cu linte.', 'Compune o strofă amuzantă despre luni dimineața.', 'Sugerează-mi câteva jocuri pentru echipă.',
    'Rezervă-mi o masă pentru doi diseară la opt.', 'Te rog rezervă o sală de ședințe pentru joi dimineață.', 'Comandă-mi un taxi la aeroport mâine la șase.', 'Pune-mi un memento să sun la dentist luni.'] };

/** Unrelated requests (write, translate, recommend): no checkable statement or question (`no_request`). */
export const OFF_TOPIC_GENERATORS = [
  { method: 'general_request', make: (random, language) => random.pick(OFF_TOPIC[language]) },
  { method: 'polite_general_request', make: (random, language) => `${language === 'ro' ? random.pick(['Te rog, ', 'Hei, ', 'O întrebare: ']) : random.pick(['Please, ', 'Hey, ', 'Random question: '])}${random.pick(OFF_TOPIC[language]).replace(/^./, c => c.toLowerCase())}` },
];

const MIXED_NO_REQUEST = ['Mersi, thanks!', 'Ok super, merci', 'Salut, how are you?', 'Bună! Nice to meet you.', 'Thanks, o zi bună!', 'Hey, ce faci?', 'Gata, that\'s all.', 'Sorry, greșeala mea.'];
const MIXED_GIBBERISH = ['sdfg șțăî qwe', 'aaaa îîî ???', 'kjh și lkj', 'nu dsfkj thx', 'ok asdlkj ăăă', 'wtf qqq șșș'];

export const UNCLEAR_GENERATORS = {
  gibberish: [...GIBBERISH, { method: 'mixed_script_mash', make: random => random.pick(MIXED_GIBBERISH) + random.pick(['', '?', '!!']) }],
  no_request: [...NOT_A_QUESTION, ...OFF_TOPIC_GENERATORS, { method: 'mixed_language_phatic', make: random => random.pick(MIXED_NO_REQUEST) }],
};

/** Make one unclear message of `kind` in `language`. Returns null when a method cannot apply. */
export function makeUnclear(kind, { random, language, choose }) {
  const methods = UNCLEAR_GENERATORS[kind].map(method => ({ id: `unclear.${kind}.${method.method}`, ...method }));
  for (let attempt = 0; attempt < 6; attempt++) {
    const method = choose ? choose(`unclear:${kind}`, methods) : random.pick(methods);
    const text = method.make(random, language);
    if (text && text.trim()) return { text: text.trim(), kind, method: method.method, id: method.id };
  }
  return null;
}
