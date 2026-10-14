/** Authored lexicon of constructions. A predicate (the verification world's relation, with named domain roles)
 * is expressed by several *constructions* per language; each construction has a relation phrase (the lemma the
 * model writes, e.g. "work at", "be employed by", "lucra la") and maps its surface positions to the closed role
 * set of the model surface: subject, object and the obliques recipient, location, source, destination,
 * instrument, time, topic. Surface forms (statement, negation, past, questions, wh, embedded, how-many) are
 * generated from a compact verb spec, with explicit overrides where Romanian or English needs them.
 *
 * Every string here is original project text; the construction inventory is inspired by the paraphrase
 * operations measured in QQP/PAWS (voice alternation, converse verbs, light-verb constructions, preposition
 * changes) and by QA2D question-to-declarative rewrites (wh-fronting, auxiliary inversion).
 */

export const CLOSED_ROLES = ['subject', 'object', 'recipient', 'location', 'source', 'destination', 'instrument', 'time', 'topic'];

/** Verification-world predicate id of a construction orientation: the direct id, or `<id>__converse`. */
export const orientedPredicate = (id, converse) => converse ? `${id}__converse` : id;

const WH_EN = { person: 'who', company: 'which company', school: 'which school', clinic: 'which clinic', office: 'which office', venue: 'which venue', team: 'which team', city: 'which town', course: 'which subject', substance: 'what', food: 'what', asset: 'what', product: 'what', event: 'which event', work: 'which book', system: 'which system', document: 'which document', site: 'what', transport: 'what', payment: 'what', vehicle: 'which vehicle', plant: 'what', choir: 'which choir' };
const PLURAL_EN = { person: 'people', company: 'companies', school: 'schools', clinic: 'clinics', office: 'offices', venue: 'venues', team: 'teams', city: 'towns', course: 'subjects', substance: 'things', food: 'things', asset: 'properties', product: 'products', event: 'events', work: 'books', system: 'systems', document: 'documents', site: 'places', transport: 'means', payment: 'methods', vehicle: 'vehicles', plant: 'plants', choir: 'choirs' };
const WH_RO = { person: 'cine', company: 'ce firmă', school: 'ce școală', clinic: 'ce clinică', office: 'ce instituție', venue: 'ce loc', team: 'ce echipă', city: 'ce oraș', course: 'ce materie', substance: 'ce', food: 'ce', asset: 'ce', product: 'ce', event: 'ce eveniment', work: 'ce carte', system: 'ce sistem', document: 'ce act', site: 'ce loc', transport: 'ce', payment: 'ce', vehicle: 'ce vehicul', plant: 'ce', choir: 'ce cor' };
const PLURAL_RO = { person: ['oameni', 'câți'], company: ['firme', 'câte'], school: ['școli', 'câte'], clinic: ['clinici', 'câte'], office: ['instituții', 'câte'], venue: ['locuri', 'câte'], team: ['echipe', 'câte'], city: ['orașe', 'câte'], course: ['materii', 'câte'], substance: ['lucruri', 'câte'], food: ['lucruri', 'câte'], asset: ['proprietăți', 'câte'], product: ['produse', 'câte'], event: ['evenimente', 'câte'], work: ['cărți', 'câte'], system: ['sisteme', 'câte'], document: ['acte', 'câte'], site: ['locuri', 'câte'], transport: ['mijloace', 'câte'], payment: ['metode', 'câte'], vehicle: ['vehicule', 'câte'], plant: ['plante', 'câte'], choir: ['coruri', 'câte'] };

const join = (...parts) => parts.filter(Boolean).join(' ');

/** English forms of a construction. `{S}` and `{O}` are the subject and object surface slots. */
function englishForms(c, types) {
  // An authored-only construction (no forms) is never realized from its verb spec.
  if (c.onlyForms && !Object.keys(c.forms ?? {}).length) return {};
  const f = {};
  const tail = join(c.obj0, c.prep);
  const S = '{S}', O = c.O ? '{O}' : '';
  if (c.cop) {
    f.s = [join(S, 'is', c.cop, O)]; f.n = [join(S, 'is not', c.cop, O), join(S, "isn't", c.cop, O)];
    f.sp = [join(S, 'was', c.cop, O)]; f.np = [join(S, 'was not', c.cop, O), join(S, "wasn't", c.cop, O)];
    f.q = [join('is', S, c.cop, O)]; f.qp = [join('was', S, c.cop, O)];
    // Negative questions ask about the negated proposition: "is X not …". Preposed "isn't X …" is a
    // positive-biased question in English and is deliberately not used for negated propositions.
    f.nq = [join('is', S, 'not', c.cop, O)]; f.nqp = [join('was', S, 'not', c.cop, O)];
    f.whS = [join(WH_EN[types.S] ?? 'who', 'is', c.cop, O)]; f.whpS = [join(WH_EN[types.S] ?? 'who', 'was', c.cop, O)];
    if (c.O) { f.whO = [join(WH_EN[types.O], 'is', S, c.cop)]; f.whpO = [join(WH_EN[types.O], 'was', S, c.cop)]; f.embO = [join(WH_EN[types.O], S, 'is', c.cop)]; f.cntO = [join('how many', PLURAL_EN[types.O], 'is', S, c.cop)]; }
    // A copula with a singular noun phrase ("the owner of") cannot take a plural subject; no how-many form then.
    f.embS = f.whS; f.cntS = /^(the|a|an) /.test(c.cop) ? [] : [join('how many', PLURAL_EN[types.S], 'are', c.cop, O)];
    if (WHERE_ROLES.has(c.Orole)) { const bare = c.cop.replace(/(^| )(in|at|to|on)$/, '').trim(); f.whereO = [join('where is', S, bare)]; f.wherepO = [join('where was', S, bare)]; f.whereembO = [join('where', S, 'is', bare)]; f.wherepembO = [join('where', S, 'was', bare)]; }
  } else {
    const [base, s3, past] = c.verb;
    f.s = [join(S, s3, tail, O)]; f.n = [join(S, 'does not', base, tail, O), join(S, "doesn't", base, tail, O)];
    f.sp = [join(S, past, tail, O)]; f.np = [join(S, 'did not', base, tail, O), join(S, "didn't", base, tail, O)];
    f.q = [join('does', S, base, tail, O)]; f.qp = [join('did', S, base, tail, O)];
    f.nq = [join('does', S, 'not', base, tail, O)]; f.nqp = [join('did', S, 'not', base, tail, O)];
    f.whS = [join(WH_EN[types.S] ?? 'who', s3, tail, O)]; f.whpS = [join(WH_EN[types.S] ?? 'who', past, tail, O)]; f.embS = f.whS;
    f.cntS = [join('how many', PLURAL_EN[types.S], base, tail, O)];
    if (c.O) {
      f.whO = [join(WH_EN[types.O], 'does', S, base, tail)]; f.whpO = [join(WH_EN[types.O], 'did', S, base, tail)];
      f.embO = [join(WH_EN[types.O], S, s3, tail)]; f.cntO = [join('how many', PLURAL_EN[types.O], 'does', S, base, tail)];
      if (c.where) { f.whO.push(join('where does', S, base, c.obj0)); f.whpO.push(join('where did', S, base, c.obj0)); f.embO.push(join('where', S, s3, c.obj0)); }
      if (WHERE_ROLES.has(c.Orole) && c.prep) { f.whereO = [join('where does', S, base, c.obj0)]; f.wherepO = [join('where did', S, base, c.obj0)]; f.whereembO = [join('where', S, s3, c.obj0)]; f.wherepembO = [join('where', S, past, c.obj0)]; }
    }
  }
  return c.onlyForms ? { ...c.forms } : { ...f, ...(c.forms ?? {}) };
}
/** "Where" questions ask for a location, or a destination for motion verbs (DS014 question forms). */
const WHERE_ROLES = new Set(['location', 'destination']);

/** Romanian forms. Gender slots: {g:S:m:f} agrees with the subject filler. */
function romanianForms(c, types) {
  // An authored-only construction (no forms) is never realized from its verb spec.
  if (c.onlyForms && !Object.keys(c.forms ?? {}).length) return {};
  const f = {};
  const S = '{S}', O = c.O ? '{O}' : '';
  const prep = c.prep ?? '';
  const pe = c.pe ? 'pe' : '';
  const cl = c.pe ? '{g:O:îl:o}' : '';
  const clPast = c.pe ? '{g:O:l-a:a}' : '';
  const whO = c.O ? (c.pe ? 'pe cine' : join(prep, WH_RO[types.O])) : '';
  if (c.cop) {
    const adj = `{g:S:${c.cop.m}:${c.cop.f}}`;
    f.s = [join(S, 'e', adj, prep, O), join(S, 'este', adj, prep, O)]; f.n = [join(S, 'nu e', adj, prep, O), join(S, 'nu este', adj, prep, O)];
    f.sp = [join(S, 'a fost', adj, prep, O)]; f.np = [join(S, 'nu a fost', adj, prep, O), join(S, "n-a fost", adj, prep, O)];
    f.q = f.s; f.qp = f.sp; f.nq = f.n; f.nqp = f.np;
    f.whS = [join(WH_RO[types.S] ?? 'cine', 'e', c.cop.m, prep, O)]; f.whpS = [join(WH_RO[types.S] ?? 'cine', 'a fost', c.cop.m, prep, O)]; f.embS = f.whS;
    const [plural, how] = PLURAL_RO[types.S] ?? ['oameni', 'câți'];
    f.cntS = [join(how, plural, 'sunt', c.cop.pl, prep, O)];
    // No how-many over the object of a Romanian copula ("de la câte echipe e în lotul X" is not natural).
    if (c.O) { f.whO = [join(whO, 'e', adj, S)]; f.whpO = [join(whO, 'a fost', adj, S)]; f.embO = f.whO; }
    if (WHERE_ROLES.has(c.Orole)) { f.whereO = [join('unde e', adj, S)]; f.wherepO = [join('unde a fost', adj, S)]; f.whereembO = f.whereO; f.wherepembO = f.wherepO; }
  } else {
    // Plural agreement for how-many subjects: "a împrumutat" → "au împrumutat", "s-a vaccinat" → "s-au vaccinat".
    const { p3, p3pl = c.v.p3.replace(/^a /, 'au ').replace(/^s-a /, 's-au '), past, pastpl = c.v.past.replace(/^a /, 'au ') } = c.v;
    const obj0 = c.obj0 ?? '';
    f.s = [join(S, cl, p3, obj0, pe || prep, O)]; f.n = [join(S, 'nu', cl, p3, obj0, pe || prep, O)];
    // With a personal direct object Romanian doubles it with a clitic: "l-a coordonat pe Radu", "a coordonat-o pe Maria".
    const participle = clPast ? `${past.replace(/^a /, '')}{g:O::-o}` : past;
    f.sp = [join(S, clPast || null, participle, obj0, pe || prep, O)];
    f.np = [join(S, 'nu', clPast || null, participle, obj0, pe || prep, O)];
    f.q = f.s; f.qp = f.sp; f.nq = f.n; f.nqp = f.np;
    f.whS = [join(WH_RO[types.S] ?? 'cine', cl, p3, obj0, pe || prep, O)]; f.whpS = [join(WH_RO[types.S] ?? 'cine', clPast || null, participle, obj0, pe || prep, O)]; f.embS = f.whS;
    const [plural, how] = PLURAL_RO[types.S] ?? ['oameni', 'câți'];
    f.cntS = [join(how, plural, cl ? '{g:O:îl:o}' : '', p3pl, obj0, pe || prep, O)];
    if (c.O) {
      f.whO = [join(whO, p3, obj0, S)]; f.whpO = [join(whO, past, obj0, S)]; f.embO = f.whO;
      const [pO, hO] = PLURAL_RO[types.O]; f.cntO = [join(c.pe ? 'pe' : prep, hO, pO, p3, obj0, S)];
      if (c.where) { f.whO.push(join('unde', p3, obj0, S)); f.whpO.push(join('unde', past, obj0, S)); }
      if (WHERE_ROLES.has(c.Orole) && c.prep) { f.whereO = [join('unde', p3, obj0, S)]; f.wherepO = [join('unde', past, obj0, S)]; f.whereembO = f.whereO; f.wherepembO = f.wherepO; }
    }
  }
  // `onlyForms`: the construction's authored forms are complete; no default form is derived from its verb spec.
  return c.onlyForms ? { ...c.forms } : { ...f, ...(c.forms ?? {}) };
}

/**
 * Build a predicate: roles are the verification world's domain roles; constructions map S/O to them. A
 * construction whose subject is the first domain role is *direct*; one whose subject is the second is a
 * *converse* (employ, belong to, host). All direct constructions of a predicate share one closed role for the
 * second argument, as do all converse ones, so the host can link a relation phrase by its role set.
 */
function predicate(spec) {
  const noCount = spec.noCount;
  // Held-out constructions (DS015 "Out-of-distribution suite") are appended after the in-distribution ones, so
  // the ids of existing constructions never shift; they are flagged `oodOnly` and never reach formalizer-v1.
  for (const language of ['en', 'ro']) spec[language] = [...spec[language], ...(spec.heldout?.[language] ?? []).map(c => ({ ...c, oodOnly: true }))];
  const roleType = Object.fromEntries(spec.roles);
  const first = spec.roles[0][0];
  const orole = converse => [...spec.en, ...spec.ro].find(c => c.O && (c.S !== first) === converse)?.Orole ?? 'object';
  spec.closedRoles = { direct: orole(false), converse: orole(true) };
  for (const language of ['en', 'ro']) spec[language] = spec[language].map((c, index) => {
    const types = { S: roleType[c.S], O: c.O ? roleType[c.O] : null };
    const converse = c.S !== first;
    const resolved = { ...c, Orole: c.O ? spec.closedRoles[converse ? 'converse' : 'direct'] : null };
    const forms = language === 'en' ? englishForms(resolved, types) : romanianForms(resolved, types);
    if (noCount) { delete forms.cntS; delete forms.cntO; }
    return { id: `${language}.${index}`, rel: c.rel, S: c.S, O: c.O ?? null, converse, oodOnly: Boolean(c.oodOnly), Orole: c.O ? spec.closedRoles[converse ? 'converse' : 'direct'] : null, forms };
  });
  return spec;
}
const V = (base, s3, past) => [base, s3, past];

/**
 * Held-out constructions of in-distribution predicates: direct constructions that never occur in formalizer-v1
 * (train, dev or test) and appear only in the construction axis of the out-of-distribution suite, so it tests
 * whether a formalizer copies an unseen relation phrase of a known relation instead of recalling the phrases it
 * was trained on. The list is the single source; DS015 documents it.
 */
export const HELDOUT_CONSTRUCTIONS = {
  works_at: { en: [{ rel: 'be on the payroll of', S: 'employee', O: 'employer', cop: 'on the payroll of' }],
    ro: [{ rel: 'avea un post la', S: 'employee', O: 'employer', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'un post', prep: 'la' }] },
  lives_in: { en: [{ rel: 'reside in', S: 'resident', O: 'town', verb: V('reside', 'resides', 'resided'), prep: 'in', Orole: 'location', where: true }],
    ro: [{ rel: 'trăi în', S: 'resident', O: 'town', v: { p3: 'trăiește', p3pl: 'trăiesc', past: 'a trăit' }, prep: 'în', Orole: 'location', where: true }] },
  sells: { en: [{ rel: 'stock', S: 'seller', O: 'product', verb: V('stock', 'stocks', 'stocked') }],
    ro: [{ rel: 'comercializa', S: 'seller', O: 'product', v: { p3: 'comercializează', past: 'a comercializat' } }] },
  attended: { en: [{ rel: 'show up at', S: 'attendee', O: 'event', verb: V('show', 'shows', 'showed'), obj0: 'up', prep: 'at' }],
    ro: [{ rel: 'fi prezent la', S: 'attendee', O: 'event', cop: { m: 'prezent', f: 'prezentă', pl: 'prezenți' }, prep: 'la' }] },
  teaches: { en: [{ rel: 'lecture in', S: 'teacher', O: 'subject', verb: V('lecture', 'lectures', 'lectured'), prep: 'in' }],
    ro: [{ rel: 'da lecții de', S: 'teacher', O: 'subject', v: { p3: 'dă', p3pl: 'dau', past: 'a dat' }, obj0: 'lecții', prep: 'de' }] },
  coaches: { en: [{ rel: 'be the trainer of', S: 'coach', O: 'team', cop: 'the trainer of' }],
    ro: [{ rel: 'pregăti', S: 'coach', O: 'team', v: { p3: 'pregătește', p3pl: 'pregătesc', past: 'a pregătit' } }] },
  maintains: { en: [{ rel: 'take care of', S: 'engineer', O: 'system', verb: V('take', 'takes', 'took'), obj0: 'care', prep: 'of' }],
    ro: [{ rel: 'avea grijă de', S: 'engineer', O: 'system', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'grijă', prep: 'de' }] },
  studies_at: { en: [{ rel: 'attend classes at', S: 'student', O: 'school', verb: V('attend', 'attends', 'attended'), obj0: 'classes', prep: 'at' }],
    ro: [{ rel: 'frecventa', S: 'student', O: 'school', v: { p3: 'frecventează', past: 'a frecventat' } }] },
  travelled_to: { en: [{ rel: 'go on a trip to', S: 'traveller', O: 'destination', verb: V('go', 'goes', 'went'), obj0: 'on a trip', prep: 'to', Orole: 'destination', where: true }],
    ro: [{ rel: 'pleca la', S: 'traveller', O: 'destination', v: { p3: 'pleacă', p3pl: 'pleacă', past: 'a plecat' }, prep: 'la', Orole: 'destination', where: true }] },
};

export const PREDICATES = {
  works_at: predicate({ heldout: HELDOUT_CONSTRUCTIONS.works_at, domain: 'work', roles: [['employee', 'person'], ['employer', 'company']], gloss: 'works for', senseAliases: { en: ['be an employee of', 'be on the staff of'], ro: ['fi angajatul', 'fi salariat la'] },
    en: [{ rel: 'work at', S: 'employee', O: 'employer', verb: V('work', 'works', 'worked'), prep: 'at' }, { rel: 'work for', S: 'employee', O: 'employer', verb: V('work', 'works', 'worked'), prep: 'for' },
      { rel: 'be employed by', S: 'employee', O: 'employer', cop: 'employed by' }, { rel: 'employ', S: 'employer', O: 'employee', verb: V('employ', 'employs', 'employed') },
      { rel: 'have a job at', S: 'employee', O: 'employer', verb: V('have', 'has', 'had'), obj0: 'a job', prep: 'at' }],
    ro: [{ rel: 'lucra la', S: 'employee', O: 'employer', v: { p3: 'lucrează', past: 'a lucrat' }, prep: 'la' }, { rel: 'fi angajat la', S: 'employee', O: 'employer', cop: { m: 'angajat', f: 'angajată', pl: 'angajați' }, prep: 'la' },
      { rel: 'munci la', S: 'employee', O: 'employer', v: { p3: 'muncește', p3pl: 'muncesc', past: 'a muncit' }, prep: 'la' }] }),
  manages: predicate({ domain: 'work', roles: [['manager', 'person'], ['report', 'person']], gloss: 'manages',
    en: [{ rel: 'manage', S: 'manager', O: 'report', verb: V('manage', 'manages', 'managed') }, { rel: 'report to', S: 'report', O: 'manager', verb: V('report', 'reports', 'reported'), prep: 'to' },
      { rel: 'be the boss of', S: 'manager', O: 'report', cop: 'the boss of' }, { rel: 'work under', S: 'report', O: 'manager', verb: V('work', 'works', 'worked'), prep: 'under' }],
    ro: [{ rel: 'coordona', S: 'manager', O: 'report', v: { p3: 'coordonează', past: 'a coordonat' }, pe: true }, { rel: 'raporta către', S: 'report', O: 'manager', v: { p3: 'raportează', past: 'a raportat' }, prep: 'către' },
      { rel: 'fi șeful lui', S: 'manager', O: 'report', cop: { m: 'șeful', f: 'șefa', pl: 'șefii' }, prep: 'lui' }] }),
  parent_of: predicate({ domain: 'family', roles: [['parent', 'person'], ['child', 'person']], gloss: 'is a parent of',
    en: [{ rel: 'be a parent of', S: 'parent', O: 'child', cop: 'a parent of' }, { rel: 'be a child of', S: 'child', O: 'parent', cop: 'a child of', forms: { whO: ['whose child is {S}', 'who is {S} a child of'] } }, { rel: 'raise', S: 'parent', O: 'child', verb: V('raise', 'raises', 'raised') }],
    ro: [{ rel: 'fi părintele lui', S: 'parent', O: 'child', cop: { m: 'părintele', f: 'părintele', pl: 'părinții' }, prep: 'lui' }, { rel: 'fi copilul lui', S: 'child', O: 'parent', cop: { m: 'copilul', f: 'copilul', pl: 'copiii' }, prep: 'lui' },
      { rel: 'crește', S: 'parent', O: 'child', v: { p3: 'crește', p3pl: 'cresc', past: 'a crescut' }, pe: true }] }),
  married_to: predicate({ noCount: true, domain: 'family', roles: [['spouse', 'person'], ['partner', 'person']], gloss: 'is married to',
    en: [{ rel: 'be married to', S: 'spouse', O: 'partner', cop: 'married to' }, { rel: 'be the spouse of', S: 'spouse', O: 'partner', cop: 'the spouse of' }],
    ro: [{ rel: 'fi căsătorit cu', S: 'spouse', O: 'partner', cop: { m: 'căsătorit', f: 'căsătorită', pl: 'căsătoriți' }, prep: 'cu' }] }),
  // (married_to and located_in have no how-many questions: counting spouses or towns of a site is unnatural)
  studies_at: predicate({ heldout: HELDOUT_CONSTRUCTIONS.studies_at, domain: 'education', roles: [['student', 'person'], ['school', 'school']], gloss: 'studies at', senseAliases: { en: ['be a student at'], ro: ['fi elev la'] },
    en: [{ rel: 'study at', S: 'student', O: 'school', verb: V('study', 'studies', 'studied'), prep: 'at' }, { rel: 'be enrolled at', S: 'student', O: 'school', cop: 'enrolled at' }, { rel: 'go to', S: 'student', O: 'school', verb: V('go', 'goes', 'went'), prep: 'to', Orole: 'destination' }],
    ro: [{ rel: 'învăța la', S: 'student', O: 'school', v: { p3: 'învață', past: 'a învățat' }, prep: 'la' }, { rel: 'fi înscris la', S: 'student', O: 'school', cop: { m: 'înscris', f: 'înscrisă', pl: 'înscriși' }, prep: 'la' }] }),
  teaches: predicate({ heldout: HELDOUT_CONSTRUCTIONS.teaches, domain: 'education', roles: [['teacher', 'person'], ['subject', 'course']], gloss: 'teaches',
    en: [{ rel: 'teach', S: 'teacher', O: 'subject', verb: V('teach', 'teaches', 'taught') }, { rel: 'give classes in', S: 'teacher', O: 'subject', verb: V('give', 'gives', 'gave'), obj0: 'classes', prep: 'in', Orole: 'topic' }],
    ro: [{ rel: 'preda', S: 'teacher', O: 'subject', v: { p3: 'predă', p3pl: 'predau', past: 'a predat' } }, { rel: 'ține ore de', S: 'teacher', O: 'subject', v: { p3: 'ține', p3pl: 'țin', past: 'a ținut' }, obj0: 'ore', prep: 'de', Orole: 'topic' }] }),
  treats: predicate({ domain: 'health', roles: [['doctor', 'person'], ['patient', 'person']], gloss: 'treats',
    en: [{ rel: 'treat', S: 'doctor', O: 'patient', verb: V('treat', 'treats', 'treated') }, { rel: 'be the doctor of', S: 'doctor', O: 'patient', cop: 'the doctor of' }, { rel: 'be treated by', S: 'patient', O: 'doctor', cop: 'treated by' }],
    ro: [{ rel: 'trata', S: 'doctor', O: 'patient', v: { p3: 'tratează', past: 'a tratat' }, pe: true }, { rel: 'fi medicul lui', S: 'doctor', O: 'patient', cop: { m: 'medicul', f: 'medicul', pl: 'medicii' }, prep: 'lui' },
      { rel: 'se trata la', S: 'patient', O: 'doctor', v: { p3: 'se tratează', past: 's-a tratat', pastpl: 's-au tratat' }, prep: 'la' }] }),
  allergic_to: predicate({ domain: 'health', roles: [['person', 'person'], ['allergen', 'substance']], gloss: 'is allergic to',
    en: [{ rel: 'be allergic to', S: 'person', O: 'allergen', cop: 'allergic to' }, { rel: 'have an allergy to', S: 'person', O: 'allergen', verb: V('have', 'has', 'had'), obj0: 'an allergy', prep: 'to' }],
    ro: [{ rel: 'fi alergic la', S: 'person', O: 'allergen', cop: { m: 'alergic', f: 'alergică', pl: 'alergici' }, prep: 'la' }, { rel: 'avea alergie la', S: 'person', O: 'allergen', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'alergie', prep: 'la' },
      { rel: 'face alergie la', S: 'person', O: 'allergen', v: { p3: 'face', p3pl: 'fac', past: 'a făcut' }, obj0: 'alergie', prep: 'la' }] }),
  lives_in: predicate({ heldout: HELDOUT_CONSTRUCTIONS.lives_in, domain: 'housing', roles: [['resident', 'person'], ['town', 'city']], gloss: 'lives in',
    en: [{ rel: 'live in', S: 'resident', O: 'town', verb: V('live', 'lives', 'lived'), prep: 'in', Orole: 'location', where: true }, { rel: 'be based in', S: 'resident', O: 'town', cop: 'based in', Orole: 'location' }],
    ro: [{ rel: 'locui în', S: 'resident', O: 'town', v: { p3: 'locuiește', p3pl: 'locuiesc', past: 'a locuit' }, prep: 'în', Orole: 'location', where: true }, { rel: 'sta în', S: 'resident', O: 'town', v: { p3: 'stă', p3pl: 'stau', past: 'a stat' }, prep: 'în', Orole: 'location', where: true }] }),
  owns: predicate({ domain: 'housing', roles: [['owner', 'person'], ['property', 'asset']], gloss: 'owns', senseAliases: { en: ['have'], ro: ['avea'] },
    en: [{ rel: 'own', S: 'owner', O: 'property', verb: V('own', 'owns', 'owned'), forms: { whS: ['who owns {O}'] } }, { rel: 'belong to', S: 'property', O: 'owner', verb: V('belong', 'belongs', 'belonged'), prep: 'to' }, { rel: 'be the owner of', S: 'owner', O: 'property', cop: 'the owner of' }],
    ro: [{ rel: 'deține', S: 'owner', O: 'property', v: { p3: 'deține', p3pl: 'dețin', past: 'a deținut' } }] }),
  sells: predicate({ heldout: HELDOUT_CONSTRUCTIONS.sells, domain: 'commerce', roles: [['seller', 'company'], ['product', 'product']], gloss: 'sells',
    en: [{ rel: 'sell', S: 'seller', O: 'product', verb: V('sell', 'sells', 'sold') }, { rel: 'carry', S: 'seller', O: 'product', verb: V('carry', 'carries', 'carried') }],
    ro: [{ rel: 'vinde', S: 'seller', O: 'product', v: { p3: 'vinde', p3pl: 'vând', past: 'a vândut' } }, { rel: 'avea de vânzare', S: 'seller', O: 'product', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'de vânzare' }] }),
  supplies: predicate({ domain: 'commerce', roles: [['supplier', 'company'], ['client', 'company']], gloss: 'supplies',
    en: [{ rel: 'supply', S: 'supplier', O: 'client', verb: V('supply', 'supplies', 'supplied') }, { rel: 'buy from', S: 'client', O: 'supplier', verb: V('buy', 'buys', 'bought'), prep: 'from', Orole: 'source' }, { rel: 'be a supplier of', S: 'supplier', O: 'client', cop: 'a supplier of' }],
    ro: [{ rel: 'aproviziona', S: 'supplier', O: 'client', v: { p3: 'aprovizionează', past: 'a aprovizionat' } }, { rel: 'cumpăra de la', S: 'client', O: 'supplier', v: { p3: 'cumpără', past: 'a cumpărat' }, prep: 'de la', Orole: 'source' }] }),
  attended: predicate({ heldout: HELDOUT_CONSTRUCTIONS.attended, domain: 'events', roles: [['attendee', 'person'], ['event', 'event']], gloss: 'attended', senseAliases: { en: ['be at'], ro: ['fi participant la'] },
    en: [{ rel: 'attend', S: 'attendee', O: 'event', verb: V('attend', 'attends', 'attended') }, { rel: 'go to', S: 'attendee', O: 'event', verb: V('go', 'goes', 'went'), prep: 'to', Orole: 'destination' }, { rel: 'take part in', S: 'attendee', O: 'event', verb: V('take', 'takes', 'took'), obj0: 'part', prep: 'in' }],
    ro: [{ rel: 'participa la', S: 'attendee', O: 'event', v: { p3: 'participă', past: 'a participat' }, prep: 'la' }, { rel: 'merge la', S: 'attendee', O: 'event', v: { p3: 'merge', p3pl: 'merg', past: 'a mers' }, prep: 'la', Orole: 'destination' }] }),
  held_at: predicate({ domain: 'events', roles: [['event', 'event'], ['venue', 'venue']], gloss: 'takes place at',
    en: [{ rel: 'take place at', S: 'event', O: 'venue', verb: V('take', 'takes', 'took'), obj0: 'place', prep: 'at', Orole: 'location', where: true }, { rel: 'be held at', S: 'event', O: 'venue', cop: 'held at', Orole: 'location' }, { rel: 'host', S: 'venue', O: 'event', verb: V('host', 'hosts', 'hosted') }],
    ro: [{ rel: 'avea loc la', S: 'event', O: 'venue', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'loc', prep: 'la', Orole: 'location', where: true }, { rel: 'găzdui', S: 'venue', O: 'event', v: { p3: 'găzduiește', p3pl: 'găzduiesc', past: 'a găzduit' } }] }),
  wrote: predicate({ domain: 'arts', roles: [['author', 'person'], ['work', 'work']], gloss: 'wrote', senseAliases: { en: ['make'], ro: ['face'] },
    en: [{ rel: 'write', S: 'author', O: 'work', verb: V('write', 'writes', 'wrote'), forms: { q: ['did {S} write {O}'], s: ['{S} wrote {O}'], n: ['{S} did not write {O}', "{S} didn't write {O}"] } }, { rel: 'be written by', S: 'work', O: 'author', cop: 'written by', forms: { s: ['{S} was written by {O}'], q: ['was {S} written by {O}'], n: ['{S} was not written by {O}'] } }, { rel: 'be the author of', S: 'author', O: 'work', cop: 'the author of' }],
    ro: [{ rel: 'scrie', S: 'author', O: 'work', v: { p3: 'a scris', past: 'a scris' }, forms: { s: ['{S} a scris {O}'], n: ['{S} nu a scris {O}', '{S} n-a scris {O}'], q: ['{S} a scris {O}'] } }, { rel: 'fi autorul', S: 'author', O: 'work', cop: { m: 'autorul', f: 'autoarea', pl: 'autorii' }, prep: 'cărții', forms: { whO: [], whpO: [], embO: [] } }] }),
  published: predicate({ domain: 'arts', roles: [['publisher', 'company'], ['work', 'work']], gloss: 'published', senseAliases: { en: ['make'], ro: ['face'] },
    en: [{ rel: 'publish', S: 'publisher', O: 'work', verb: V('publish', 'publishes', 'published'), forms: { s: ['{S} published {O}'], q: ['did {S} publish {O}'], n: ['{S} did not publish {O}'], whS: ['who published {O}', 'which house published {O}'], embS: ['who published {O}'] } }],
    ro: [{ rel: 'publica', S: 'publisher', O: 'work', v: { p3: 'a publicat', past: 'a publicat' }, forms: { s: ['{S} a publicat {O}'], q: ['{S} a publicat {O}'], n: ['{S} nu a publicat {O}'], whS: ['cine a publicat {O}', 'ce editură a publicat {O}'], embS: ['cine a publicat {O}'] } }] }),
  borrowed: predicate({ domain: 'arts', roles: [['reader', 'person'], ['book', 'work']], gloss: 'borrowed', senseAliases: { en: ['have'], ro: ['avea'] },
    en: [{ rel: 'borrow', S: 'reader', O: 'book', verb: V('borrow', 'borrows', 'borrowed'), forms: { whS: ['who borrowed {O}'], s: ['{S} borrowed {O}', '{S} has borrowed {O}'], q: ['did {S} borrow {O}', 'has {S} borrowed {O}'] } }, { rel: 'check out', S: 'reader', O: 'book', verb: V('check', 'checks', 'checked'), forms: { s: ['{S} checked out {O}'], sp: ['{S} checked out {O}'], q: ['did {S} check out {O}'], qp: ['did {S} check out {O}'], n: ['{S} did not check out {O}'], np: ['{S} did not check out {O}'], whS: ['who checked out {O}'], whpS: ['who checked out {O}'], embS: ['who checked out {O}'], nq: ['did {S} not check out {O}'], nqp: ['did {S} not check out {O}'], whO: ['which book did {S} check out'], whpO: ['which book did {S} check out'], embO: ['which book {S} checked out'], cntS: ['how many people checked out {O}'], cntO: ['how many books did {S} check out'] } }],
    ro: [{ rel: 'împrumuta', S: 'reader', O: 'book', v: { p3: 'a împrumutat', past: 'a împrumutat' } }] }),
  plays_for: predicate({ domain: 'sports', roles: [['player', 'person'], ['team', 'team']], gloss: 'plays for', senseAliases: { en: ['be a player of'], ro: ['fi jucător la'] },
    en: [{ rel: 'play for', S: 'player', O: 'team', verb: V('play', 'plays', 'played'), prep: 'for' }, { rel: 'be on', S: 'player', O: 'team', cop: 'on' }],
    ro: [{ rel: 'juca la', S: 'player', O: 'team', v: { p3: 'joacă', p3pl: 'joacă', past: 'a jucat' }, prep: 'la' }, { rel: 'fi în lotul', S: 'player', O: 'team', cop: { m: 'în lotul', f: 'în lotul', pl: 'în lotul' }, prep: 'de la' }] }),
  coaches: predicate({ heldout: HELDOUT_CONSTRUCTIONS.coaches, domain: 'sports', roles: [['coach', 'person'], ['team', 'team']], gloss: 'coaches',
    en: [{ rel: 'coach', S: 'coach', O: 'team', verb: V('coach', 'coaches', 'coached') }, { rel: 'be the coach of', S: 'coach', O: 'team', cop: 'the coach of' }, { rel: 'train', S: 'coach', O: 'team', verb: V('train', 'trains', 'trained') }],
    ro: [{ rel: 'antrena', S: 'coach', O: 'team', v: { p3: 'antrenează', past: 'a antrenat' } }, { rel: 'fi antrenorul', S: 'coach', O: 'team', cop: { m: 'antrenorul', f: 'antrenoarea', pl: 'antrenorii' }, prep: 'de la' }] }),
  maintains: predicate({ heldout: HELDOUT_CONSTRUCTIONS.maintains, domain: 'tech', roles: [['engineer', 'person'], ['system', 'system']], gloss: 'maintains',
    en: [{ rel: 'maintain', S: 'engineer', O: 'system', verb: V('maintain', 'maintains', 'maintained') }, { rel: 'be responsible for', S: 'engineer', O: 'system', cop: 'responsible for', Orole: 'topic' }, { rel: 'look after', S: 'engineer', O: 'system', verb: V('look', 'looks', 'looked'), prep: 'after' }],
    ro: [{ rel: 'întreține', S: 'engineer', O: 'system', v: { p3: 'întreține', p3pl: 'întrețin', past: 'a întreținut' } }, { rel: 'răspunde de', S: 'engineer', O: 'system', v: { p3: 'răspunde', p3pl: 'răspund', past: 'a răspuns' }, prep: 'de', Orole: 'topic' },
      { rel: 'se ocupa de', S: 'engineer', O: 'system', v: { p3: 'se ocupă', past: 's-a ocupat', pastpl: 's-au ocupat' }, prep: 'de', Orole: 'topic' }] }),
  depends_on: predicate({ domain: 'tech', roles: [['dependent', 'system'], ['dependency', 'system']], gloss: 'depends on',
    en: [{ rel: 'depend on', S: 'dependent', O: 'dependency', verb: V('depend', 'depends', 'depended'), prep: 'on' }, { rel: 'rely on', S: 'dependent', O: 'dependency', verb: V('rely', 'relies', 'relied'), prep: 'on' }],
    ro: [{ rel: 'depinde de', S: 'dependent', O: 'dependency', v: { p3: 'depinde', p3pl: 'depind', past: 'a depins' }, prep: 'de' }, { rel: 'se baza pe', S: 'dependent', O: 'dependency', v: { p3: 'se bazează', past: 's-a bazat', pastpl: 's-au bazat' }, prep: 'pe' }] }),
  issued: predicate({ domain: 'admin', roles: [['office', 'office'], ['document', 'document']], gloss: 'issues',
    en: [{ rel: 'issue', S: 'office', O: 'document', verb: V('issue', 'issues', 'issued') }, { rel: 'be issued by', S: 'document', O: 'office', cop: 'issued by', Orole: 'object' }],
    ro: [{ rel: 'elibera', S: 'office', O: 'document', v: { p3: 'eliberează', past: 'a eliberat' } }, { rel: 'se elibera la', S: 'document', O: 'office', v: { p3: 'se eliberează', past: 's-a eliberat', pastpl: 's-au eliberat' }, prep: 'la', Orole: 'object' }] }),
  requires: predicate({ domain: 'admin', roles: [['goal', 'document'], ['prerequisite', 'document']], gloss: 'requires',
    en: [{ rel: 'require', S: 'goal', O: 'prerequisite', verb: V('require', 'requires', 'required') }, { rel: 'be required for', S: 'prerequisite', O: 'goal', cop: 'required for', Orole: 'topic' }],
    ro: [{ rel: 'necesita', S: 'goal', O: 'prerequisite', v: { p3: 'necesită', past: 'a necesitat' } }, { rel: 'cere', S: 'goal', O: 'prerequisite', v: { p3: 'cere', p3pl: 'cer', past: 'a cerut' } }] }),
  located_in: predicate({ noCount: true, domain: 'places', roles: [['site', 'site'], ['town', 'city']], gloss: 'is located in',
    en: [{ rel: 'be in', S: 'site', O: 'town', cop: 'in', Orole: 'location' }, { rel: 'be located in', S: 'site', O: 'town', cop: 'located in', Orole: 'location' }, { rel: 'be based in', S: 'site', O: 'town', cop: 'based in', Orole: 'location' }],
    ro: [{ rel: 'se afla în', S: 'site', O: 'town', v: { p3: 'se află', past: 'se afla', pastpl: 'se aflau' }, prep: 'în', Orole: 'location', where: true }, { rel: 'fi în', S: 'site', O: 'town', cop: { m: '', f: '', pl: '' }, prep: 'în', Orole: 'location' }, { rel: 'avea sediul în', S: 'site', O: 'town', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'sediul', prep: 'în', Orole: 'location' }] }),
  travelled_to: predicate({ heldout: HELDOUT_CONSTRUCTIONS.travelled_to, domain: 'travel', roles: [['traveller', 'person'], ['destination', 'city']], gloss: 'travelled to',
    en: [{ rel: 'travel to', S: 'traveller', O: 'destination', verb: V('travel', 'travels', 'travelled'), prep: 'to', Orole: 'destination', where: true }, { rel: 'visit', S: 'traveller', O: 'destination', verb: V('visit', 'visits', 'visited') }, { rel: 'fly to', S: 'traveller', O: 'destination', verb: V('fly', 'flies', 'flew'), prep: 'to', Orole: 'destination' }],
    ro: [{ rel: 'călători la', S: 'traveller', O: 'destination', v: { p3: 'călătorește', p3pl: 'călătoresc', past: 'a călătorit' }, prep: 'la', Orole: 'destination', where: true }, { rel: 'vizita', S: 'traveller', O: 'destination', v: { p3: 'vizitează', past: 'a vizitat' } }] }),
  // Means and manner: "how" questions ask for the instrument role (DS014). The bare verbs are sense aliases, so
  // "How does Ana commute?" (relation "commute", role instrument ?how) links to the same predicate.
  commutes_by: predicate({ noCount: true, domain: 'travel', roles: [['commuter', 'person'], ['means', 'transport']], gloss: 'commutes by', senseAliases: { en: ['commute', 'get to work', 'go to work'], ro: ['face naveta', 'merge la serviciu', 'ajunge la serviciu'] },
    en: [{ rel: 'commute by', S: 'commuter', O: 'means', verb: V('commute', 'commutes', 'commuted'), prep: 'by', Orole: 'instrument' }, { rel: 'go to work by', S: 'commuter', O: 'means', verb: V('go', 'goes', 'went'), obj0: 'to work', prep: 'by', Orole: 'instrument' },
      { rel: 'get to work by', S: 'commuter', O: 'means', verb: V('get', 'gets', 'got'), obj0: 'to work', prep: 'by', Orole: 'instrument' }],
    ro: [{ rel: 'face naveta cu', S: 'commuter', O: 'means', v: { p3: 'face naveta', p3pl: 'fac naveta', past: 'a făcut naveta' }, prep: 'cu', Orole: 'instrument' }, { rel: 'merge la serviciu cu', S: 'commuter', O: 'means', v: { p3: 'merge la serviciu', p3pl: 'merg la serviciu', past: 'a mers la serviciu' }, prep: 'cu', Orole: 'instrument' }] }),
  pays_with: predicate({ noCount: true, domain: 'commerce', roles: [['payer', 'person'], ['method', 'payment']], gloss: 'pays with', senseAliases: { en: ['pay', 'settle the bill'], ro: ['plăti', 'achita'] },
    en: [{ rel: 'pay with', S: 'payer', O: 'method', verb: V('pay', 'pays', 'paid'), prep: 'with', Orole: 'instrument' }, { rel: 'settle the bill with', S: 'payer', O: 'method', verb: V('settle', 'settles', 'settled'), obj0: 'the bill', prep: 'with', Orole: 'instrument' }],
    ro: [{ rel: 'plăti cu', S: 'payer', O: 'method', v: { p3: 'plătește', p3pl: 'plătesc', past: 'a plătit' }, prep: 'cu', Orole: 'instrument' }, { rel: 'achita cu', S: 'payer', O: 'method', v: { p3: 'achită', p3pl: 'achită', past: 'a achitat' }, prep: 'cu', Orole: 'instrument' }] }),
  // Out-of-distribution domains: these predicates appear only in the OOD suite (DS015 corpus split), so it measures
  // whether a formalizer copies unseen relation phrases instead of recalling the training lexicon.
  cooks_at: predicate({ ood: true, domain: 'food', roles: [['chef', 'person'], ['kitchen', 'venue']], gloss: 'cooks at',
    en: [{ rel: 'cook at', S: 'chef', O: 'kitchen', verb: V('cook', 'cooks', 'cooked'), prep: 'at' }, { rel: 'be the chef at', S: 'chef', O: 'kitchen', cop: 'the chef at' }],
    ro: [{ rel: 'găti la', S: 'chef', O: 'kitchen', v: { p3: 'gătește', p3pl: 'gătesc', past: 'a gătit' }, prep: 'la' }, { rel: 'fi bucătar la', S: 'chef', O: 'kitchen', cop: { m: 'bucătar', f: 'bucătăreasă', pl: 'bucătari' }, prep: 'la' }] }),
  repairs: predicate({ ood: true, domain: 'garage', roles: [['mechanic', 'person'], ['vehicle', 'vehicle']], gloss: 'repairs',
    en: [{ rel: 'repair', S: 'mechanic', O: 'vehicle', verb: V('repair', 'repairs', 'repaired') }, { rel: 'fix', S: 'mechanic', O: 'vehicle', verb: V('fix', 'fixes', 'fixed') }, { rel: 'be repaired by', S: 'vehicle', O: 'mechanic', cop: 'repaired by' }],
    ro: [{ rel: 'repara', S: 'mechanic', O: 'vehicle', v: { p3: 'repară', p3pl: 'repară', past: 'a reparat' } }, { rel: 'se ocupa de', S: 'mechanic', O: 'vehicle', v: { p3: 'se ocupă', p3pl: 'se ocupă', past: 's-a ocupat', pastpl: 's-au ocupat' }, prep: 'de' }] }),
  grows: predicate({ ood: true, domain: 'garden', roles: [['gardener', 'person'], ['plant', 'plant']], gloss: 'grows',
    en: [{ rel: 'grow', S: 'gardener', O: 'plant', verb: V('grow', 'grows', 'grew') }, { rel: 'plant', S: 'gardener', O: 'plant', verb: V('plant', 'plants', 'planted') }],
    ro: [{ rel: 'cultiva', S: 'gardener', O: 'plant', v: { p3: 'cultivă', p3pl: 'cultivă', past: 'a cultivat' } }, { rel: 'planta', S: 'gardener', O: 'plant', v: { p3: 'plantează', past: 'a plantat' } }] }),
  sings_in: predicate({ ood: true, domain: 'music', roles: [['singer', 'person'], ['choir', 'choir']], gloss: 'sings in',
    en: [{ rel: 'sing in', S: 'singer', O: 'choir', verb: V('sing', 'sings', 'sang'), prep: 'in' }, { rel: 'be a member of', S: 'singer', O: 'choir', cop: 'a member of' }],
    ro: [{ rel: 'cânta în', S: 'singer', O: 'choir', v: { p3: 'cântă', p3pl: 'cântă', past: 'a cântat' }, prep: 'în' }, { rel: 'fi membru în', S: 'singer', O: 'choir', cop: { m: 'membru', f: 'membră', pl: 'membri' }, prep: 'în' }] }),
  rents: predicate({ ood: true, domain: 'lettings', roles: [['tenant', 'person'], ['property', 'asset']], gloss: 'rents',
    en: [{ rel: 'rent', S: 'tenant', O: 'property', verb: V('rent', 'rents', 'rented') }, { rel: 'lease', S: 'tenant', O: 'property', verb: V('lease', 'leases', 'leased') }],
    ro: [{ rel: 'închiria', S: 'tenant', O: 'property', v: { p3: 'închiriază', past: 'a închiriat' } }] }), // "stă cu chirie în" fits dwellings only; the property pool also holds vineyards, vans and boats.
  // Unary venue states for homonym ambiguity ("Is the court free?": a tennis court or a courtroom).
  open_now: predicate({ domain: 'places', roles: [['place', 'venue']], gloss: 'is open',
    en: [{ rel: 'be open', S: 'place', cop: 'open' }], ro: [{ rel: 'fi deschis', S: 'place', cop: { m: 'deschis', f: 'deschisă', pl: 'deschise' } }] }),
  available: predicate({ domain: 'places', roles: [['place', 'venue']], gloss: 'is free to book',
    en: [{ rel: 'be free', S: 'place', cop: 'free' }, { rel: 'be available', S: 'place', cop: 'available' }], ro: [{ rel: 'fi liber', S: 'place', cop: { m: 'liber', f: 'liberă', pl: 'libere' } }, { rel: 'fi disponibil', S: 'place', cop: { m: 'disponibil', f: 'disponibilă', pl: 'disponibile' } }] }),
  // Unary states: the subject only, sometimes with a fixed object phrase that is part of the construction.
  certified: predicate({ domain: 'work', roles: [['holder', 'person']], gloss: 'holds a valid certificate',
    en: [{ rel: 'be certified', S: 'holder', cop: 'certified' }, { rel: 'have a valid certificate', S: 'holder', verb: V('have', 'has', 'had'), obj0: 'a valid certificate' }],
    ro: [{ rel: 'fi certificat', S: 'holder', cop: { m: 'certificat', f: 'certificată', pl: 'certificați' } }, { rel: 'avea certificat valabil', S: 'holder', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'certificat valabil' }] }),
  trained: predicate({ domain: 'work', roles: [['trainee', 'person']], gloss: 'completed the safety training',
    en: [{ rel: 'complete the safety training', S: 'trainee', verb: V('complete', 'completes', 'completed'), obj0: 'the safety training', forms: { s: ['{S} has completed the safety training', '{S} completed the safety training'], q: ['has {S} completed the safety training', 'did {S} complete the safety training'] } }, { rel: 'be trained', S: 'trainee', cop: 'trained' }],
    ro: [{ rel: 'termina instruirea de siguranță', S: 'trainee', v: { p3: 'a terminat', past: 'a terminat' }, obj0: 'instruirea de siguranță' }, { rel: 'fi instruit', S: 'trainee', cop: { m: 'instruit', f: 'instruită', pl: 'instruiți' } }] }),
  authorized: predicate({ domain: 'work', roles: [['person', 'person']], gloss: 'may enter the lab',
    en: [{ rel: 'have access to the lab', S: 'person', verb: V('have', 'has', 'had'), obj0: 'access to the lab' }, { rel: 'be cleared for the lab', S: 'person', cop: 'cleared for the lab' }],
    ro: [{ rel: 'avea acces în laborator', S: 'person', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'acces în laborator' }] }),
  eligible: predicate({ domain: 'work', roles: [['candidate', 'person']], gloss: 'is eligible for the bonus',
    en: [{ rel: 'be eligible for the bonus', S: 'candidate', cop: 'eligible for the bonus' }, { rel: 'qualify for the bonus', S: 'candidate', verb: V('qualify', 'qualifies', 'qualified'), obj0: 'for the bonus' }],
    ro: [{ rel: 'fi eligibil pentru bonus', S: 'candidate', cop: { m: 'eligibil pentru bonus', f: 'eligibilă pentru bonus', pl: 'eligibili pentru bonus' } }, { rel: 'lua bonusul', S: 'candidate', v: { p3: 'ia', p3pl: 'iau', past: 'a luat' }, obj0: 'bonusul' }] }),
  vaccinated: predicate({ domain: 'health', roles: [['person', 'person']], gloss: 'had the flu vaccine', senseAliases: { en: ['be vaccinated', 'have the flu shot'], ro: [] },
    en: [{ rel: 'be vaccinated against the flu', S: 'person', cop: 'vaccinated against the flu' }, { rel: 'get the flu shot', S: 'person', verb: V('get', 'gets', 'got'), obj0: 'the flu shot' }],
    ro: [{ rel: 'se vaccina antigripal', S: 'person', v: { p3: 's-a vaccinat', past: 's-a vaccinat', pastpl: 's-au vaccinat' }, obj0: 'antigripal' }, { rel: 'fi vaccinat', S: 'person', cop: { m: 'vaccinat', f: 'vaccinată', pl: 'vaccinați' } }] }),
  absent: predicate({ domain: 'work', roles: [['person', 'person']], gloss: 'is absent from work',
    en: [{ rel: 'be absent from work', S: 'person', cop: 'absent from work' }, { rel: 'stay home', S: 'person', verb: V('stay', 'stays', 'stayed'), obj0: 'home' }],
    ro: [{ rel: 'lipsi de la serviciu', S: 'person', v: { p3: 'lipsește', p3pl: 'lipsesc', past: 'a lipsit' }, obj0: 'de la serviciu' }] }),
  ill: predicate({ domain: 'health', roles: [['person', 'person']], gloss: 'is ill',
    en: [{ rel: 'be ill', S: 'person', cop: 'ill' }, { rel: 'be sick', S: 'person', cop: 'sick' }, { rel: 'have the flu', S: 'person', verb: V('have', 'has', 'had'), obj0: 'the flu' }],
    ro: [{ rel: 'fi bolnav', S: 'person', cop: { m: 'bolnav', f: 'bolnavă', pl: 'bolnavi' } }, { rel: 'avea gripă', S: 'person', v: { p3: 'are', p3pl: 'au', past: 'a avut' }, obj0: 'gripă' }] }),
  down: predicate({ domain: 'tech', roles: [['system', 'system']], gloss: 'is down',
    en: [{ rel: 'be down', S: 'system', cop: 'down' }, { rel: 'be out of service', S: 'system', cop: 'out of service' }],
    ro: [{ rel: 'fi căzut', S: 'system', cop: { m: 'căzut', f: 'căzută', pl: 'căzute' }, forms: { sp: ['{S} a căzut'], np: ['{S} nu a căzut'], qp: ['{S} a căzut'], nqp: ['{S} nu a căzut'], whpS: ['ce sistem a căzut'] } }, { rel: 'pica', S: 'system', v: { p3: 'a picat', past: 'a picat' } }] }),
  overloaded: predicate({ domain: 'tech', roles: [['system', 'system']], gloss: 'is overloaded',
    en: [{ rel: 'be overloaded', S: 'system', cop: 'overloaded' }, { rel: 'be under too much load', S: 'system', cop: 'under too much load' }],
    ro: [{ rel: 'fi supraîncărcat', S: 'system', cop: { m: 'supraîncărcat', f: 'supraîncărcată', pl: 'supraîncărcate' } }] }),
  caused_outage: predicate({ domain: 'tech', roles: [['cause', 'system'], ['effect', 'system']], gloss: 'caused the outage of',
    en: [{ rel: 'bring down', S: 'cause', O: 'effect', verb: V('bring', 'brings', 'brought'), onlyForms: true, forms: { s: ['{S} brought down {O}'], sp: ['{S} brought down {O}'], n: ['{S} did not bring down {O}'], np: ['{S} did not bring down {O}'], q: ['did {S} bring down {O}'], qp: ['did {S} bring down {O}'], nq: ['did {S} not bring down {O}'], nqp: ['did {S} not bring down {O}'], whS: ['what brought down {O}'], whpS: ['what brought down {O}'], embS: ['what brought down {O}'] } }, { rel: 'cause the outage of', S: 'cause', O: 'effect', verb: V('cause', 'causes', 'caused'), obj0: 'the outage of', forms: { s: ['{S} caused the outage of {O}'], q: ['did {S} cause the outage of {O}'], whS: ['what caused the outage of {O}'], embS: ['what caused the outage of {O}'], n: ['{S} did not cause the outage of {O}'] } }],
    // Romanian: the genitive of an articled noun ("căderea lui aplicația") is avoided with "din cauza problemelor cu X".
    ro: [{ rel: 'cădea din cauza problemelor cu', S: 'effect', O: 'cause', Orole: 'topic', v: { p3: 'a căzut', past: 'a căzut' }, onlyForms: true, forms: { s: ['{S} a căzut din cauza problemelor cu {O}'], sp: ['{S} a căzut din cauza problemelor cu {O}'], n: ['{S} nu a căzut din cauza problemelor cu {O}'], np: ['{S} nu a căzut din cauza problemelor cu {O}'], q: ['{S} a căzut din cauza problemelor cu {O}'], qp: ['{S} a căzut din cauza problemelor cu {O}'], nq: ['{S} nu a căzut din cauza problemelor cu {O}'], nqp: ['{S} nu a căzut din cauza problemelor cu {O}'] } },
      { rel: 'cădea din cauza', S: 'effect', O: 'cause', Orole: 'topic', v: { p3: 'a căzut', past: 'a căzut' }, onlyForms: true, forms: { whO: ['din cauza cărui sistem a căzut {S}'], whpO: ['din cauza cărui sistem a căzut {S}'], embO: ['din cauza cărui sistem a căzut {S}'] } }] }),
  wants_to_move: predicate({ domain: 'intention', roles: [['person', 'person'], ['destination', 'city']], gloss: 'wants to move to',
    en: [{ rel: 'want to move to', S: 'person', O: 'destination', verb: V('want', 'wants', 'wanted'), obj0: 'to move', prep: 'to', Orole: 'destination' }, { rel: 'plan to relocate to', S: 'person', O: 'destination', verb: V('plan', 'plans', 'planned'), obj0: 'to relocate', prep: 'to', Orole: 'destination' }],
    ro: [{ rel: 'vrea să se mute în', S: 'person', O: 'destination', v: { p3: 'vrea', p3pl: 'vor', past: 'a vrut' }, obj0: 'să se mute', prep: 'în', Orole: 'destination' }] }),
  plans_to_leave: predicate({ domain: 'intention', roles: [['person', 'person'], ['employer', 'company']], gloss: 'intends to leave',
    en: [{ rel: 'plan to leave', S: 'person', O: 'employer', verb: V('plan', 'plans', 'planned'), obj0: 'to leave', Orole: 'source' }, { rel: 'intend to quit', S: 'person', O: 'employer', verb: V('intend', 'intends', 'intended'), obj0: 'to quit', Orole: 'source' }],
    ro: [{ rel: 'vrea să plece de la', S: 'person', O: 'employer', v: { p3: 'vrea', p3pl: 'vor', past: 'a vrut' }, obj0: 'să plece', prep: 'de la', Orole: 'source' }] }),
  // Causal pairs (observation, cause relation), authored for the causal and abduction families.
  sick_from: predicate({ domain: 'health', roles: [['person', 'person'], ['cause', 'food']], gloss: 'got sick because of',
    en: [{ rel: 'get sick from', S: 'person', O: 'cause', verb: V('get', 'gets', 'got'), obj0: 'sick', prep: 'from', Orole: 'source', forms: { s: ['{S} got sick from {O}'], n: ['{S} did not get sick from {O}'], q: ['did {S} get sick from {O}'], whO: ['what did {S} get sick from'], embO: ['what {S} got sick from'], sp: ['{S} got sick from {O}'], np: ['{S} did not get sick from {O}'], qp: ['did {S} get sick from {O}'], nqp: ['did {S} not get sick from {O}'] } }, { rel: 'make sick', S: 'cause', O: 'person', verb: V('make', 'makes', 'made'), onlyForms: true, forms: { whpS: ['what made {O} sick'], s: ['{S} made {O} sick'], n: ['{S} did not make {O} sick'], q: ['did {S} make {O} sick'], sp: ['{S} made {O} sick'], np: ['{S} did not make {O} sick'], qp: ['did {S} make {O} sick'], nq: ['did {S} not make {O} sick'], nqp: ['did {S} not make {O} sick'], whS: ['what made {O} sick'], embS: ['what made {O} sick'] } }],
    ro: [{ rel: 'se îmbolnăvi de la', S: 'person', O: 'cause', v: { p3: 's-a îmbolnăvit', past: 's-a îmbolnăvit' }, prep: 'de la', Orole: 'source', forms: { s: ['{S} s-a îmbolnăvit de la {O}'], n: ['{S} nu s-a îmbolnăvit de la {O}'], q: ['{S} s-a îmbolnăvit de la {O}'], whO: ['de la ce s-a îmbolnăvit {S}'], embO: ['de la ce s-a îmbolnăvit {S}'] } }] }),
  closed_for: predicate({ domain: 'events', roles: [['venue', 'venue'], ['event', 'event']], gloss: 'is closed because of',
    en: [{ rel: 'be closed for', S: 'venue', O: 'event', cop: 'closed for', Orole: 'topic', forms: { s: ['{S} is closed for {O}'], n: ['{S} is not closed for {O}'], q: ['is {S} closed for {O}'], whO: ['what is {S} closed for'], embO: ['what {S} is closed for'] } }],
    ro: [{ rel: 'fi închis pentru', S: 'venue', O: 'event', cop: { m: 'închis', f: 'închisă', pl: 'închise' }, prep: 'pentru', Orole: 'topic', forms: { whO: ['pentru ce e {g:S:închis:închisă} {S}'], embO: ['pentru ce e {g:S:închis:închisă} {S}'] } }] }),
  delayed_by: predicate({ domain: 'events', roles: [['event', 'event'], ['cause', 'system']], gloss: 'was postponed because of problems with',
    en: [{ rel: 'be postponed because of', S: 'event', O: 'cause', cop: 'postponed because of', Orole: 'topic', forms: { s: ['{S} was postponed because of {O}'], n: ['{S} was not postponed because of {O}'], q: ['was {S} postponed because of {O}'], whO: ['what was {S} postponed because of'], embO: ['what {S} was postponed because of'] } }],
    ro: [{ rel: 'fi amânat din cauza problemelor cu', S: 'event', O: 'cause', cop: { m: 'amânat', f: 'amânată', pl: 'amânate' }, Orole: 'topic', onlyForms: true, forms: { s: ['{S} a fost {g:S:amânat:amânată} din cauza problemelor cu {O}'], sp: ['{S} a fost {g:S:amânat:amânată} din cauza problemelor cu {O}'], n: ['{S} nu a fost {g:S:amânat:amânată} din cauza problemelor cu {O}'], np: ['{S} nu a fost {g:S:amânat:amânată} din cauza problemelor cu {O}'], q: ['{S} a fost {g:S:amânat:amânată} din cauza problemelor cu {O}'], qp: ['{S} a fost {g:S:amânat:amânată} din cauza problemelor cu {O}'], whO: ['din cauza problemelor cu ce sistem a fost {g:S:amânat:amânată} {S}'], whpO: ['din cauza problemelor cu ce sistem a fost {g:S:amânat:amânată} {S}'], embO: ['din cauza problemelor cu ce sistem a fost {g:S:amânat:amânată} {S}'] } }] }),
  quit_over: predicate({ domain: 'work', roles: [['person', 'person'], ['cause', 'person']], gloss: 'resigned because of conflicts with',
    en: [{ rel: 'quit because of', S: 'person', O: 'cause', verb: V('quit', 'quits', 'quit'), prep: 'because of', Orole: 'topic', forms: { s: ['{S} quit because of {O}'], n: ['{S} did not quit because of {O}'], q: ['did {S} quit because of {O}'], whO: ['who did {S} quit because of'], embO: ['who {S} quit because of'] } }],
    ro: [{ rel: 'demisiona din cauza conflictelor cu', S: 'person', O: 'cause', v: { p3: 'a demisionat', past: 'a demisionat' }, Orole: 'topic', onlyForms: true, forms: { s: ['{S} a demisionat din cauza conflictelor cu {O}'], sp: ['{S} a demisionat din cauza conflictelor cu {O}'], n: ['{S} nu a demisionat din cauza conflictelor cu {O}'], np: ['{S} nu a demisionat din cauza conflictelor cu {O}'], q: ['{S} a demisionat din cauza conflictelor cu {O}'], qp: ['{S} a demisionat din cauza conflictelor cu {O}'] } },
      { rel: 'demisiona din cauza', S: 'person', O: 'cause', v: { p3: 'a demisionat', past: 'a demisionat' }, Orole: 'topic', onlyForms: true, forms: { whO: ['din cauza cui a demisionat {S}'], whpO: ['din cauza cui a demisionat {S}'], embO: ['din cauza cui a demisionat {S}'] } }] }),
  closed_today: predicate({ domain: 'events', roles: [['venue', 'venue']], gloss: 'is closed',
    en: [{ rel: 'be closed', S: 'venue', cop: 'closed' }], ro: [{ rel: 'fi închis', S: 'venue', cop: { m: 'închis', f: 'închisă', pl: 'închise' } }] }),
  postponed: predicate({ domain: 'events', roles: [['event', 'event']], gloss: 'was postponed',
    en: [{ rel: 'be postponed', S: 'event', cop: 'postponed', forms: { s: ['{S} was postponed', '{S} got postponed'], q: ['was {S} postponed'], n: ['{S} was not postponed'] } }],
    ro: [{ rel: 'fi amânat', S: 'event', cop: { m: 'amânat', f: 'amânată', pl: 'amânate' }, forms: { s: ['{S} a fost {g:S:amânat:amânată}'], q: ['{S} a fost {g:S:amânat:amânată}'], n: ['{S} nu a fost {g:S:amânat:amânată}'] } }] }),
  resigned: predicate({ domain: 'work', roles: [['person', 'person']], gloss: 'resigned',
    // "handed in her notice" is its own relation phrase: the model never rewrites it into "resign" (DS015 relation phrases).
    en: [{ rel: 'resign', S: 'person', verb: V('resign', 'resigns', 'resigned'), forms: { s: ['{S} resigned'], q: ['did {S} resign'], n: ['{S} did not resign'] } },
      { rel: 'hand in notice', S: 'person', verb: V('hand', 'hands', 'handed'), onlyForms: true, forms: { s: ['{S} handed in {g:S:his:her} notice'], sp: ['{S} handed in {g:S:his:her} notice'], q: ['did {S} hand in {g:S:his:her} notice'], qp: ['did {S} hand in {g:S:his:her} notice'], n: ['{S} did not hand in {g:S:his:her} notice'], np: ['{S} did not hand in {g:S:his:her} notice'] } }],
    ro: [{ rel: 'demisiona', S: 'person', v: { p3: 'a demisionat', past: 'a demisionat' }, forms: { s: ['{S} a demisionat'], q: ['{S} a demisionat'], n: ['{S} nu a demisionat'] } },
      { rel: 'da demisia', S: 'person', v: { p3: 'și-a dat demisia', past: 'și-a dat demisia' }, onlyForms: true, forms: { s: ['{S} și-a dat demisia'], sp: ['{S} și-a dat demisia'], q: ['{S} și-a dat demisia'], qp: ['{S} și-a dat demisia'], n: ['{S} nu și-a dat demisia'], np: ['{S} nu și-a dat demisia'] } }] }),
  wants_to_learn: predicate({ domain: 'intention', roles: [['person', 'person'], ['subject', 'course']], gloss: 'wants to learn',
    en: [{ rel: 'want to learn', S: 'person', O: 'subject', verb: V('want', 'wants', 'wanted'), obj0: 'to learn', Orole: 'topic' }, { rel: 'plan to study', S: 'person', O: 'subject', verb: V('plan', 'plans', 'planned'), obj0: 'to study', Orole: 'topic' }],
    ro: [{ rel: 'vrea să învețe', S: 'person', O: 'subject', v: { p3: 'vrea', p3pl: 'vor', past: 'a vrut' }, obj0: 'să învețe', Orole: 'topic' }] }),
  plans_to_attend: predicate({ domain: 'intention', roles: [['person', 'person'], ['event', 'event']], gloss: 'intends to attend',
    en: [{ rel: 'plan to go to', S: 'person', O: 'event', verb: V('plan', 'plans', 'planned'), obj0: 'to go', prep: 'to', Orole: 'object' }, { rel: 'intend to attend', S: 'person', O: 'event', verb: V('intend', 'intends', 'intended'), obj0: 'to attend', Orole: 'object' }],
    ro: [{ rel: 'vrea să meargă la', S: 'person', O: 'event', v: { p3: 'vrea', p3pl: 'vor', past: 'a vrut' }, obj0: 'să meargă', prep: 'la', Orole: 'object' }, { rel: 'plănui să participe la', S: 'person', O: 'event', v: { p3: 'plănuiește', p3pl: 'plănuiesc', past: 'a plănuit' }, obj0: 'să participe', prep: 'la', Orole: 'object' }] }),
  // Authored-only predicates of the expansion families (families-expansion.mjs, DS015 "Expansion families"): their
  // messages are authored per family, so the constructions carry no generated forms (`onlyForms` with none) and
  // the generic families never draw them (`authored`). Value roles take integers or strings as written (C11).
  costs: predicate({ authored: true, domain: 'values', roles: [['item', 'asset'], ['price', 'integer']], gloss: 'costs',
    en: [{ rel: 'cost', S: 'item', O: 'price', verb: V('cost', 'costs', 'cost'), onlyForms: true, forms: {} }],
    ro: [{ rel: 'costa', S: 'item', O: 'price', v: { p3: 'costă', past: 'a costat' }, onlyForms: true, forms: {} }] }),
  aged: predicate({ authored: true, domain: 'values', roles: [['person', 'person'], ['age', 'integer']], gloss: 'is aged',
    en: [{ rel: 'be old', S: 'person', O: 'age', cop: 'old', onlyForms: true, forms: {} }],
    ro: [{ rel: 'avea ani', S: 'person', O: 'age', v: { p3: 'are', past: 'a avut' }, onlyForms: true, forms: {} }] }),
  opens_at: predicate({ authored: true, domain: 'values', roles: [['venue', 'venue'], ['hour', 'value']], gloss: 'opens at',
    en: [{ rel: 'open at', S: 'venue', O: 'hour', verb: V('open', 'opens', 'opened'), prep: 'at', Orole: 'time', onlyForms: true, forms: {} }],
    ro: [{ rel: 'se deschide la', S: 'venue', O: 'hour', v: { p3: 'se deschide', past: 's-a deschis' }, prep: 'la', Orole: 'time', onlyForms: true, forms: {} }] }),
  sent_to: predicate({ authored: true, domain: 'transfers', roles: [['sender', 'person'], ['item', 'value'], ['recipient', 'person']], thirdRole: 'recipient', gloss: 'sent to',
    en: [{ rel: 'send', S: 'sender', O: 'item', verb: V('send', 'sends', 'sent'), onlyForms: true, forms: {} }],
    ro: [{ rel: 'trimite', S: 'sender', O: 'item', v: { p3: 'trimite', past: 'a trimis' }, onlyForms: true, forms: {} }] }),
  moved: predicate({ authored: true, domain: 'transfers', roles: [['person', 'person'], ['origin', 'city'], ['destination', 'city']], thirdRole: 'destination', gloss: 'moved from … to',
    en: [{ rel: 'move', S: 'person', O: 'origin', verb: V('move', 'moves', 'moved'), Orole: 'source', onlyForms: true, forms: {} }],
    ro: [{ rel: 'se muta', S: 'person', O: 'origin', v: { p3: 'se mută', past: 's-a mutat' }, Orole: 'source', onlyForms: true, forms: {} }] }),
  bought_together: predicate({ authored: true, domain: 'housing', roles: [['buyers', 'group'], ['property', 'asset']], gloss: 'bought together',
    en: [{ rel: 'buy together', S: 'buyers', O: 'property', verb: V('buy', 'buys', 'bought'), onlyForms: true, forms: {} }],
    ro: [{ rel: 'cumpăra împreună', S: 'buyers', O: 'property', v: { p3: 'cumpără', past: 'a cumpărat' }, onlyForms: true, forms: {} }] }),
  means: predicate({ authored: true, domain: 'definitions', roles: [['term', 'term'], ['meaning', 'value']], gloss: 'means',
    en: [{ rel: 'mean', S: 'term', O: 'meaning', verb: V('mean', 'means', 'meant'), onlyForms: true, forms: {} }],
    ro: [{ rel: 'însemna', S: 'term', O: 'meaning', v: { p3: 'înseamnă', past: 'a însemnat' }, onlyForms: true, forms: {} }] }),
  may_sign: predicate({ authored: true, domain: 'modality', roles: [['person', 'person'], ['document', 'document']], gloss: 'is allowed to sign',
    en: [{ rel: 'be allowed to sign', S: 'person', O: 'document', cop: 'allowed to sign', onlyForms: true, forms: {} }],
    ro: [{ rel: 'avea voie să semneze', S: 'person', O: 'document', v: { p3: 'are voie să semneze', past: 'a avut voie să semneze' }, onlyForms: true, forms: {} }] }),
  should_accept: predicate({ authored: true, domain: 'modality', roles: [['person', 'person'], ['employer', 'company']], gloss: 'should accept the offer from (advice)',
    en: [{ rel: 'should accept the offer from', S: 'person', O: 'employer', verb: V('accept', 'accepts', 'accepted'), Orole: 'source', onlyForms: true, forms: {} }],
    ro: [{ rel: 'ar trebui să accepte oferta de la', S: 'person', O: 'employer', v: { p3: 'ar trebui să accepte', past: 'ar fi trebuit să accepte' }, Orole: 'source', onlyForms: true, forms: {} }] }),
};

/** Entity pools per type (EN/RO labels). Persons come from names.mjs. */
export const ENTITY_POOLS = {
  transport: [['bike', 'bicicleta'], ['tram', 'tramvaiul'], ['bus', 'autobuzul'], ['car', 'mașina'], ['train', 'trenul'], ['scooter', 'trotineta'], ['metro', 'metroul'], ['ferry', 'bacul'], ['motorbike', 'motocicleta'], ['minibus', 'microbuzul']],
  payment: [['a debit card', 'cardul de debit'], ['cash', 'numerar'], ['a credit card', 'cardul de credit'], ['a mobile wallet', 'portofelul din telefon'], ['meal vouchers', 'tichete de masă'], ['a bank transfer', 'transfer bancar'], ['a prepaid card', 'un card preplătit'], ['gift cards', 'carduri cadou']],
  vehicle: [['the old Volvo', 'Volvo-ul vechi'], ['the delivery van', 'duba de livrări'], ['the red tractor', 'tractorul roșu'], ['the school bus', 'autobuzul școlii'], ['the vintage Beetle', 'Beetle-ul de epocă'], ['the hospital ambulance', 'ambulanța spitalului'], ['the fire engine', 'mașina de pompieri'], ['the white camper van', 'rulota albă'], ['the warehouse forklift', 'stivuitorul din depozit'], ['the yellow taxi', 'taxiul galben']],
  plant: [['tomatoes', 'roșii'], ['lavender', 'lavandă'], ['grapevines', 'viță-de-vie'], ['sunflowers', 'floarea-soarelui'], ['peppers', 'ardei'], ['strawberries', 'căpșuni'], ['roses', 'trandafiri'], ['basil', 'busuioc'], ['pumpkins', 'dovleci'], ['apple trees', 'meri']],
  choir: [['the Madrigal choir', 'corul Madrigal'], ['the church choir', 'corul bisericii'], ['the university choir', 'corul universității'], ['the chamber choir', 'corul de cameră'], ['the youth choir', 'corul de tineret'], ['the gospel choir', 'corul gospel'], ['the opera chorus', 'corul operei'], ['the folk ensemble', 'ansamblul folcloric']],
  course: [['mathematics', 'matematică'], ['chemistry', 'chimie'], ['history', 'istorie'], ['piano', 'pian'], ['Spanish', 'spaniolă'], ['biology', 'biologie'], ['geography', 'geografie'], ['physics', 'fizică'], ['drawing', 'desen'], ['computer science', 'informatică'], ['German', 'germană'], ['physical education', 'educație fizică']],
  substance: [['peanuts', 'arahide'], ['penicillin', 'penicilină'], ['pollen', 'polen'], ['lactose', 'lactoză'], ['gluten', 'gluten'], ['shellfish', 'fructe de mare'], ['cat hair', 'păr de pisică'], ['dust mites', 'acarieni'], ['strawberries', 'căpșuni'], ['ibuprofen', 'ibuprofen'], ['bee stings', 'înțepături de albină'], ['latex', 'latex']],
  // Romanian food labels are bare nouns: they only follow the preposition "de la" ("s-a îmbolnăvit de la stridii").
  food: [['the oysters', 'stridii'], ['the shrimp salad', 'salată cu creveți'], ['the undercooked chicken', 'pui nefiert bine'], ['the mushroom soup', 'ciorbă de ciuperci'], ['the potato salad', 'salată de cartofi'], ['the tap water at the hostel', 'apă de la robinet'], ['the street-food kebab', 'kebab de la colț'], ['the leftover sushi', 'sushi rămas de ieri']],
  asset: [['the flat on Mihai Viteazu Street', 'apartamentul de pe strada Mihai Viteazu'], ['the red Dacia', 'Dacia roșie'], ['the vineyard near Sibiu', 'via de lângă Sibiu'], ['the bakery on the corner', 'brutăria din colț'], ['the old sailing boat', 'barca veche cu pânze'], ['the garage behind the block', 'garajul din spatele blocului'], ['the holiday cottage in Bran', 'cabana de vacanță din Bran'], ['the blue van', 'duba albastră'], ['the plot of land by the river', 'terenul de lângă râu'], ['the recording studio', 'studioul de înregistrări']],
  product: [['winter tyres', 'anvelope de iarnă'], ['olive oil', 'ulei de măsline'], ['second-hand laptops', 'laptopuri second-hand'], ['school uniforms', 'uniforme școlare'], ['garden furniture', 'mobilier de grădină'], ['sourdough bread', 'pâine cu maia'], ['bicycle parts', 'piese de bicicletă'], ['herbal tea', 'ceai de plante'], ['LED bulbs', 'becuri LED'], ['printer ink', 'cerneală de imprimantă'], ['phone cases', 'huse de telefon'], ['baby food', 'mâncare pentru bebeluși']],
  event: [['the spring book fair', 'târgul de carte de primăvară'], ['the Tuesday board meeting', 'ședința de consiliu de marți'], ['the regional chess tournament', 'turneul regional de șah'], ['the jazz evening', 'seara de jazz'], ['the charity run', 'crosul caritabil'], ["the parents' evening", 'ședința cu părinții'], ['the product launch', 'lansarea produsului'], ['the photography workshop', 'atelierul de fotografie'], ['the harvest festival', 'festivalul recoltei'], ['the town hall debate', 'dezbaterea de la primărie'], ['the code review session', 'sesiunea de code review'], ['the wedding reception', 'petrecerea de nuntă']],
  work: [['The Salt Road', 'Drumul Sării'], ['Winter in Maramureș', 'Iarna în Maramureș'], ['A Short History of Bridges', 'O scurtă istorie a podurilor'], ['The Glass Orchard', 'Livada de sticlă'], ['Notes from the Night Train', 'Însemnări din trenul de noapte'], ["The Clockmaker's Daughter", 'Fiica ceasornicarului'], ['Soups of Transylvania', 'Ciorbele Transilvaniei'], ['The Quiet Harbour', 'Portul liniștit'], ['Letters to a Young Engineer', 'Scrisori către un tânăr inginer'], ['The Last Ferry', 'Ultimul bac']],
  system: [['the billing service', 'serviciul de facturare'], ['the payroll database', 'baza de date de salarizare'], ['the booking app', 'aplicația de rezervări'], ['the VPN gateway', 'gateway-ul VPN'], ['the analytics pipeline', 'pipeline-ul de analiză'], ['the login service', 'serviciul de autentificare'], ['the search index', 'indexul de căutare'], ['the mail server', 'serverul de e-mail'], ['the inventory API', 'API-ul de inventar'], ['the backup cluster', 'clusterul de backup'], ['the payments gateway', 'gateway-ul de plăți'], ['the reporting dashboard', 'dashboard-ul de raportare']],
  document: [['a building permit', 'autorizația de construire'], ['a passport', 'pașaportul'], ['a residence certificate', 'certificatul de rezidență'], ['a tax clearance certificate', 'certificatul de atestare fiscală'], ['a fire safety approval', 'avizul de securitate la incendiu'], ['a criminal record certificate', 'cazierul judiciar'], ['a birth certificate', 'certificatul de naștere'], ['a driving licence', 'permisul de conducere'], ['a medical certificate', 'adeverința medicală'], ['an ID card', 'cartea de identitate'], ['a land title extract', 'extrasul de carte funciară'], ['a work permit', 'permisul de muncă']],
  // Terms of the definition family (families-expansion.mjs).
  term: [['force majeure', 'forță majoră'], ['due diligence', 'due diligence'], ['a power of attorney', 'o procură'], ['escrow', 'escrow'], ['amortization', 'amortizare'], ['a lien', 'un drept de retenție'], ['the statute of limitations', 'termenul de prescripție'], ['a notarized statement', 'o declarație notarială'], ['a grace period', 'o perioadă de grație'], ['a deductible', 'o franșiză']],
};

/** Declared verification-world type of a generator entity type: organization subkinds share one type. */
export const ONTOLOGY_TYPE = { company: 'organization', school: 'organization', clinic: 'organization', office: 'organization', venue: 'organization', team: 'organization', site: 'organization' };
export const ontologyType = type => ONTOLOGY_TYPE[type] ?? type;
export const DOMAINS = [...new Set(Object.values(PREDICATES).map(p => p.domain))];
export const constructionCount = () => Object.values(PREDICATES).reduce((n, p) => n + p.en.length + p.ro.length, 0);
