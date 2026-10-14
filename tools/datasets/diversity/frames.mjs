/** Authored outer frames: question frames, claim-check frames and discourse frames, EN and RO.
 * The inventory of forms is inspired by measured source shapes (question types, embedded questions,
 * context-then-question, question-then-elaboration, imperatives, tag and declarative questions); every string
 * is original. Slots: {Q} yes/no core, {S} statement clause, {W} wh core, {E} embedded clause, {A} assertion
 * sentences, {a} assertion clause (lowercase start), {Z} the full question sentence, {P} speaker name.
 */

const f = (id, text, extra = {}) => ({ id, text, ...extra });

export const YES_NO = {
  en: [
    f('yn_direct', '{Q}?', { form: 'yes_no' }), f('yn_is_it_true', 'Is it true that {S}?', { form: 'is_it_true' }),
    f('yn_can_you_check', 'Can you check whether {S}?', { form: 'request_embedded' }), f('yn_could_you_check_if', 'Could you check if {S}?', { form: 'request_embedded' }),
    f('yn_do_you_know_if', 'Do you know if {S}?', { form: 'embedded_question' }), f('yn_wondering', 'I was wondering whether {S}.', { form: 'embedded_statement' }),
    f('yn_tag_right', '{S}, right?', { form: 'tag_question' }), f('yn_tag_correct', '{S}, correct?', { form: 'tag_question' }),
    f('yn_rising', '{S}?', { form: 'declarative_question' }), f('yn_quick_question', 'Quick question: {Q}?', { form: 'prefixed' }),
    f('yn_tell_me_whether', 'Tell me whether {S}.', { form: 'imperative' }), f('yn_any_chance', 'Any chance {S}?', { form: 'colloquial' }),
    f('yn_need_to_know', 'I need to know if {S}.', { form: 'embedded_statement' }), f('yn_is_it_the_case', 'Is it the case that {S}?', { form: 'is_it_true' }),
    f('yn_would_you_say', 'Would you say that {S}?', { form: 'opinion' }), f('yn_so', 'so {Q}?', { form: 'colloquial' }),
    f('yn_do_you_know_tail', '{Q}, do you know?', { form: 'tail_question' }), f('yn_confirm', 'Can you confirm that {S}?', { form: 'request_embedded' }),
    f('yn_just_checking', 'Just checking: {Q}?', { form: 'prefixed' }), f('yn_is_it_correct', 'Is it correct that {S}?', { form: 'is_it_true' }),
    f('yn_honestly', 'Honestly, {Q}?', { form: 'prefixed' }), f('yn_or_not', '{Q} or not?', { form: 'alternative' }),
    f('yn_wonder_if', 'I wonder if {S}.', { form: 'embedded_statement' }), f('yn_help_me', 'Help me with this one: {Q}?', { form: 'prefixed' }),
  ],
  ro: [
    f('yn_ro_rising', '{S}?', { form: 'declarative_question' }), f('yn_ro_oare', 'Oare {S}?', { form: 'particle' }),
    f('yn_ro_e_adevarat', 'E adevărat că {S}?', { form: 'is_it_true' }), f('yn_ro_poti_verifica', 'Poți să verifici dacă {S}?', { form: 'request_embedded' }),
    f('yn_ro_stii_cumva', 'Știi cumva dacă {S}?', { form: 'embedded_question' }), f('yn_ro_tag_nu', '{S}, nu?', { form: 'tag_question' }),
    f('yn_ro_tag_asa_e', '{S}, așa e?', { form: 'tag_question' }), f('yn_ro_ma_intreb', 'Mă întreb dacă {S}.', { form: 'embedded_statement' }),
    f('yn_ro_spune_mi', 'Spune-mi dacă {S}.', { form: 'imperative' }), f('yn_ro_intrebare_rapida', 'Întrebare rapidă: {S}?', { form: 'prefixed' }),
    f('yn_ro_se_poate_confirma', 'Se poate confirma că {S}?', { form: 'request_embedded' }), f('yn_ro_am_nevoie', 'Am nevoie să știu dacă {S}.', { form: 'embedded_statement' }),
    f('yn_ro_verifica_te_rog', 'Verifică, te rog, dacă {S}.', { form: 'imperative' }), f('yn_ro_chiar', 'Chiar {S}?', { form: 'particle' }),
    f('yn_ro_sincer', 'Sincer, {S}?', { form: 'prefixed' }), f('yn_ro_ai_idee', 'Ai idee dacă {S}?', { form: 'embedded_question' }),
    f('yn_ro_sau_nu', '{S} sau nu?', { form: 'alternative' }), f('yn_ro_cumva', 'Nu cumva {S}?', { form: 'particle' }),
  ],
};

export const WH = {
  en: [
    f('wh_direct', '{W}?', { form: 'wh' }), f('wh_do_you_know', 'Do you know {E}?', { form: 'embedded_question' }),
    f('wh_can_you_tell', 'Can you tell me {E}?', { form: 'request_embedded' }), f('wh_id_like', "I'd like to know {E}.", { form: 'embedded_statement' }),
    f('wh_any_idea', 'Any idea {E}?', { form: 'colloquial' }), f('wh_quick_one', 'Quick one: {W}?', { form: 'prefixed' }),
    f('wh_tell_me', 'Tell me {E}.', { form: 'imperative' }), f('wh_trying', "I'm trying to find out {E}.", { form: 'embedded_statement' }),
    f('wh_find_out', 'Please find out {E}.', { form: 'imperative' }), f('wh_if_you_know', '{W}, if you know?', { form: 'tail_question' }),
    f('wh_remind_me', 'Remind me, {W}?', { form: 'prefixed' }), f('wh_so', 'so {W}?', { form: 'colloquial' }),
    f('wh_could_you_check', 'Could you check {E}?', { form: 'request_embedded' }), f('wh_curiosity', 'Out of curiosity, {W}?', { form: 'prefixed' }),
    f('wh_need', 'I need to know {E}.', { form: 'embedded_statement' }), f('wh_wonder', 'I wonder {E}.', { form: 'embedded_statement' }),
  ],
  ro: [
    f('wh_ro_direct', '{W}?', { form: 'wh' }), f('wh_ro_stii', 'Știi {E}?', { form: 'embedded_question' }),
    f('wh_ro_poti_spune', 'Poți să-mi spui {E}?', { form: 'request_embedded' }), f('wh_ro_as_vrea', 'Aș vrea să aflu {E}.', { form: 'embedded_statement' }),
    f('wh_ro_ai_idee', 'Ai idee {E}?', { form: 'colloquial' }), f('wh_ro_zi_mi', 'Zi-mi {E}.', { form: 'imperative' }),
    f('wh_ro_ma_intereseaza', 'Mă interesează {E}.', { form: 'embedded_statement' }), f('wh_ro_intrebare_rapida', 'Întrebare rapidă: {W}?', { form: 'prefixed' }),
    f('wh_ro_afla', 'Află, te rog, {E}.', { form: 'imperative' }), f('wh_ro_oare', 'Oare {W}?', { form: 'particle' }),
    f('wh_ro_amintesti', 'Îmi amintești {E}?', { form: 'prefixed' }), f('wh_ro_curiozitate', 'Din curiozitate, {W}?', { form: 'prefixed' }),
    f('wh_ro_vreau_sa_stiu', 'Vreau să știu {E}.', { form: 'embedded_statement' }), f('wh_ro_te_rog', '{W}, te rog?', { form: 'tail_question' }),
  ],
};

/** A declarative claim the user wants checked (QA2D-inspired direction reversed): a query, never `stated`. */
export const CLAIM_CHECK = {
  en: [f('cc_check_this', 'Check this: {S}.'), f('cc_true_or_false', 'True or false: {S}.'), f('cc_fact_check', 'Fact-check: {S}.'), f('cc_is_this_correct', 'Is this correct? "{S}"'), f('cc_verify_claim', 'Verify the claim that {S}.'), f('cc_quoted', '"{S}" — does that hold?')],
  ro: [f('cc_ro_verifica', 'Verifică: {S}.'), f('cc_ro_adevarat_fals', 'Adevărat sau fals: {S}?'), f('cc_ro_corect', 'E corectă afirmația asta: {S}?'), f('cc_ro_ghilimele', '„{S}” — se confirmă?'), f('cc_ro_confirma', 'Confirmă sau infirmă: {S}.')],
};

/** Discourse frames that attach asserted material to the question. `certainty` is what the frame asserts. */
export const DISCOURSE = {
  en: [
    f('d_plain', '{A} {Z}', { certainty: 'asserted', shape: 'context_then_question' }),
    f('d_given', 'Given that {a}, {z}', { certainty: 'asserted', shape: 'presupposition_clause' }),
    f('d_since', 'Since {a}, {z}', { certainty: 'asserted', shape: 'presupposition_clause' }),
    f('d_because', '{Z} I\'m asking because {a}.', { certainty: 'asserted', shape: 'question_then_elaboration' }),
    f('d_background', 'Background: {A} Question: {Z}', { certainty: 'asserted', shape: 'labelled_sections' }),
    f('d_hi', 'Hi! {A} {Z}', { certainty: 'asserted', shape: 'greeting_then_context' }),
    f('d_okay_so', 'Okay so {a}. {Z}', { certainty: 'asserted', shape: 'colloquial_context' }),
    f('d_what_i_know', "Here's what I know: {a}. {Z}", { certainty: 'asserted', shape: 'context_then_question' }),
    f('d_for_context', '{Z} (For context: {a}.)', { certainty: 'asserted', shape: 'parenthetical' }),
    f('d_dash', '{A} — {z}', { certainty: 'asserted', shape: 'context_then_question' }),
    f('d_suppose', 'Suppose {a}. {Z}', { certainty: 'supposed', shape: 'supposition' }),
    f('d_lets_say', "Let's say {a}. {Z}", { certainty: 'supposed', shape: 'supposition' }),
    f('d_hypothetically', 'Hypothetically, if {a}, {z}', { certainty: 'supposed', shape: 'conditional_frame' }),
    f('d_i_think', 'I think {a}. {Z}', { certainty: 'hedged', shape: 'hedge' }),
    f('d_not_sure', "I'm not 100% sure, but {a}. {Z}", { certainty: 'hedged', shape: 'hedge' }),
    f('d_i_believe', 'I believe {a}. {Z}', { certainty: 'hedged', shape: 'hedge' }),
    f('d_says', '{P} says {a}. {Z}', { certainty: 'asserted', speaker: true, shape: 'reported_speech' }),
    f('d_according', 'According to {P}, {a}. {Z}', { certainty: 'asserted', speaker: true, shape: 'reported_speech' }),
    f('d_told_me', '{P} told me that {a}. {Z}', { certainty: 'asserted', speaker: true, shape: 'reported_speech' }),
  ],
  ro: [
    f('d_ro_plain', '{A} {Z}', { certainty: 'asserted', shape: 'context_then_question' }),
    f('d_ro_dat_fiind', 'Dat fiind că {a}, {z}', { certainty: 'asserted', shape: 'presupposition_clause' }),
    // "Pentru că X, …?" is a calque of "Since X, …"; Romanian says "Având în vedere că X, …".
    f('d_ro_pentru_ca', 'Având în vedere că {a}, {z}', { certainty: 'asserted', shape: 'presupposition_clause' }),
    f('d_ro_stiu', 'Știu că {a}. {Z}', { certainty: 'asserted', shape: 'context_then_question' }),
    f('d_ro_context', 'Context: {A} Întrebare: {Z}', { certainty: 'asserted', shape: 'labelled_sections' }),
    f('d_ro_salut', 'Salut! {A} {Z}', { certainty: 'asserted', shape: 'greeting_then_context' }),
    f('d_ro_deci', 'Deci, {a}. {Z}', { certainty: 'asserted', shape: 'colloquial_context' }),
    f('d_ro_intreb', '{Z} Întreb pentru că {a}.', { certainty: 'asserted', shape: 'question_then_elaboration' }),
    f('d_ro_sa_zicem', 'Să zicem că {a}. {Z}', { certainty: 'supposed', shape: 'supposition' }),
    f('d_ro_presupunem', 'Presupunem că {a}. {Z}', { certainty: 'supposed', shape: 'supposition' }),
    f('d_ro_daca', 'Ipotetic, dacă {a}, {z}', { certainty: 'supposed', shape: 'conditional_frame' }),
    f('d_ro_cred', 'Cred că {a}. {Z}', { certainty: 'hedged', shape: 'hedge' }),
    f('d_ro_parca', 'Parcă {a}. {Z}', { certainty: 'hedged', shape: 'hedge' }),
    f('d_ro_mi_se_pare', 'Mi se pare că {a}. {Z}', { certainty: 'hedged', shape: 'hedge' }),
    f('d_ro_zice', '{P} zice că {a}. {Z}', { certainty: 'asserted', speaker: true, shape: 'reported_speech' }),
    f('d_ro_potrivit', 'Potrivit lui {P}, {a}. {Z}', { certainty: 'asserted', speaker: true, shape: 'reported_speech' }),
    f('d_ro_mi_a_spus', '{P} mi-a spus că {a}. {Z}', { certainty: 'asserted', speaker: true, shape: 'reported_speech' }),
  ],
};

/** Joining several assertion clauses. */
export const JOINERS = {
  en: [f('j_and', '{x} and {y}'), f('j_semicolon', '{x}; {y}'), f('j_also', '{x}. Also, {y}'), f('j_comma_and', '{x}, and {y}'), f('j_plus', '{x}. Plus, {y}')],
  ro: [f('j_ro_si', '{x} și {y}'), f('j_ro_semicolon', '{x}; {y}'), f('j_ro_in_plus', '{x}. În plus, {y}'), f('j_ro_iar', '{x}, iar {y}', { notBeforeNegation: true }), f('j_ro_si_ca', '{x}. Și {y}')],
};

export const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  ro: ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'],
};

/**
 * Question-word frames of the DS014 question forms. Slots: {Q} the English auxiliary-inverted core ("did Ana
 * work at Acme"), {S} the declarative clause ("Ana worked at Acme"), {T} and {V} the subject and the rest of a
 * declarative clause for topicalized Romanian ("Ana de când lucrează la Acme?"), {B} an English "start to" core
 * ("did Ana start to work at Acme"), {I} a Romanian clause with the verb group before the subject ("a lucrat Ana
 * la Acme") for direct wh-questions. `past` selects past forms. Every string is original.
 */
export const TIME_FRAMES = {
  when: {
    en: [f('when_direct', 'When {Q}?', { past: true }), f('when_exactly', 'When exactly {Q}?', { past: true }), f('when_know', 'Do you know when {S}?', { past: true }), f('when_idea', 'Any idea when {S}?', { past: true }),
      f('when_period', 'In what period {Q}?', { past: true }), f('when_tell', 'Tell me when {S}.', { past: true }), f('when_dates', 'What were the dates when {S}?', { past: true }), f('when_remind', 'Remind me when {S}.', { past: true }),
      f('when_roughly', 'Roughly when {Q}?', { past: true }), f('when_need', 'I need to know when {S}.', { past: true })],
    ro: [f('when_ro_topic', '{T} când {V}?', { past: true }), f('when_ro_stii', 'Știi când {S}?', { past: true }), f('when_ro_perioada', 'În ce perioadă {I}?', { past: true }), f('when_ro_spune', 'Poți să-mi spui când {S}?', { past: true }),
      f('when_ro_anume', 'Când anume {I}?', { past: true }), f('when_ro_interes', 'Mă interesează când {S}.', { past: true }), f('when_ro_ce_ani', 'În ce ani {I}?', { past: true }), f('when_ro_zi', 'Zi-mi când {S}.', { past: true })],
  },
  since: {
    en: [f('since_direct', 'Since when {Q}?'), f('since_know', 'Do you know since when {S}?'), f('since_date', 'Since what date {Q}?'), f('since_start', 'When {B}?', { start: true }), f('since_start_know', 'Do you know when {T} started to {V}?', { start: true }),
      f('since_first', 'From what date on {Q}?'), f('since_idea', 'Any idea since when {S}?')],
    ro: [f('since_ro_direct', 'De când {I}?'), f('since_ro_topic', '{T} de când {V}?'), f('since_ro_stii', 'Știi de când {S}?'), f('since_ro_anume', 'De când anume {I}?'), f('since_ro_din_ce', 'Din ce dată {I}?'), f('since_ro_spune', 'Spune-mi de când {S}.'), f('since_ro_an', 'Din ce an {I}?'), f('since_ro_interes', 'Mă interesează de când {S}.')],
  },
  until: {
    en: [f('until_direct', 'Until when {Q}?', { past: true }), f('until_know', 'Do you know until when {S}?', { past: true }), f('until_date', 'Up to what date {Q}?', { past: true }), f('until_last', 'Until what date {Q}?', { past: true }), f('until_tell', 'Tell me until when {S}.', { past: true })],
    ro: [f('until_ro_direct', 'Până când {I}?', { past: true }), f('until_ro_topic', '{T} până când {V}?', { past: true }), f('until_ro_stii', 'Știi până când {S}?', { past: true }), f('until_ro_data', 'Până la ce dată {I}?', { past: true })],
  },
  how_long: {
    en: [f('long_direct', 'How long {Q}?', { past: true }), f('long_for', 'For how long {Q}?', { past: true }), f('long_know', 'Do you know how long {S}?', { past: true }), f('long_years', 'How many years {Q}?', { past: true }),
      f('long_time', 'How much time {Q}?', { past: true }), f('long_idea', 'Any idea how long {S}?', { past: true })],
    ro: [f('long_ro_direct', 'Cât timp {I}?', { past: true }), f('long_ro_topic', '{T} cât timp {V}?', { past: true }), f('long_ro_stii', 'Știi cât timp {S}?', { past: true }), f('long_ro_ani', 'Câți ani {I}?', { past: true }), f('long_ro_pentru', 'Pentru cât timp {I}?', { past: true }), f('long_ro_perioada', 'Pe ce perioadă de timp {I}?', { past: true }), f('long_ro_spune', 'Spune-mi cât timp {S}.', { past: true })],
  },
  how_many_times: {
    en: [f('times_direct', 'How many times {Q}?', { past: true }), f('times_often', 'How often {Q}?', { past: true }), f('times_know', 'Do you know how many times {S}?', { past: true }), f('times_occasions', 'On how many occasions {Q}?', { past: true }),
      f('times_count', 'Can you count how many times {S}?', { past: true })],
    ro: [f('times_ro_direct', 'De câte ori {I}?', { past: true }), f('times_ro_topic', '{T} de câte ori {V}?', { past: true }), f('times_ro_stii', 'Știi de câte ori {S}?', { past: true }), f('times_ro_des', 'Cât de des {I}?', { past: true }), f('times_ro_numar', 'Numără-mi de câte ori {S}.', { past: true }),
      f('times_ro_total', 'De câte ori în total {I}?', { past: true }), f('times_ro_frecvent', 'Cât de frecvent {I}?', { past: true }), f('times_ro_poti', 'Poți să-mi spui de câte ori {S}?', { past: true })],
  },
};

/** "Why" frames (mode explain). A negated proposition asks why it does not hold. */
export const WHY_FRAMES = {
  en: [f('why_direct', 'Why {Q}?'), f('why_how_come', 'How come {S}?'), f('why_know', 'Do you know why {S}?'), f('why_reason', 'What is the reason that {S}?'), f('why_explain', 'Can you explain why {S}?'),
    f('why_exactly', 'Why exactly {Q}?'), f('why_explain_me', 'Explain to me why {S}.'), f('why_what_makes', 'What makes it so that {S}?'), f('why_wonder', 'I wonder why {S}.'), f('why_curious', 'Out of curiosity, why {Q}?')],
  ro: [f('why_ro_direct', 'De ce {I}?'), f('why_ro_topic', '{T} de ce {V}?'), f('why_ro_motiv', 'Care e motivul pentru care {S}?'), f('why_ro_explica', 'Cum se explică faptul că {S}?'), f('why_ro_stii', 'Știi de ce {S}?'),
    f('why_ro_din_ce', 'Din ce motiv {I}?'), f('why_ro_explica_mi', 'Explică-mi de ce {S}.'), f('why_ro_cum_de', 'Cum de {I}?'), f('why_ro_ma_intreb', 'Mă întreb de ce {S}.')],
};
