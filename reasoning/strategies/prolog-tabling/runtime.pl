% prolog-tabling: static runtime support, loaded before every generated program (SWI-Prolog 9, tabling).
%
% The generated program defines, per relation `p` of the circuits, the tabled predicates p_p/N (positive evidence P) and
% n_p/N (negative evidence N), the data predicates rt_fact/7, rt_rule/8, rt_agg/6, rt_agg_rows/3 and rt_hyp/2, and a task
% rt_task/1 that builds the answer as a dict. Nothing here knows a relation by name.
%
% Conventions:
%   literal   l(pos|neg, Pred, Args)             Pred is the relation name (an atom), Args a list of ground values
%   premise   a literal, or absent(Pred, Args)   (a negation-as-failure marker: not a claim)
%   values    integers and atoms (quoted text and symbols with the same characters are the same atom)
%
% Budgets: the task runs under call_with_inference_limit (probes). A cut leaves INCOMPLETE tables, which are abolished before
% anything else runs (an incomplete table read later would look complete). The WALL limit is not call_with_time_limit: the alarm
% thread of library(time) deadlocks SWI-Prolog 9.0.4 at `halt` about once in 1700 runs (measured: the JSON was printed, the
% process never exited), so the wall limit is enforced by the host, which kills the process (swipl.mjs). A killed process leaves no
% table behind, which is the abolish_all_tables of the proposal (5.5) by other means.

:- use_module(library(http/json)).
:- use_module(library(lists)).
:- use_module(library(apply)).
:- use_module(library(pairs)).
:- set_prolog_flag(verbose, silent).
:- set_prolog_flag(toplevel_print_anon, false).
:- style_check(-singleton).
:- style_check(-discontiguous).

:- dynamic rt_note/1, rt_node/5, rt_bound/1.
:- dynamic rt_fact/7, rt_rule/8, rt_agg/6, rt_hyp/2, rt_closed/1, rt_domain/3, rt_derived/1.
:- discontiguous rt_fact/7, rt_rule/8, rt_agg/6, rt_agg_rows/3, rt_hyp/2, rt_closed/1, rt_domain/3, rt_derived/1.

note(N) :- ( rt_note(N) -> true ; assertz(rt_note(N)) ).

% ------------------------------------------------------------------------------------------------ values and arithmetic

date_text(A) :- atom(A), ( A == beginning ; A == open ), !.
date_text(A) :- atom(A), atom_codes(A, Cs), phrase(date_codes, Cs), !.
date_codes --> d4, "-", d2, "-", d2, ( [] ; "T", d2, ":", d2, ":", d2, "Z" ).
d4 --> d, d, d, d.
d2 --> d, d.
d --> [C], { code_type(C, digit) }.

ordinal(V, X) :- rational(V), !, X = V.
ordinal(beginning, X) :- !, X is -inf.
ordinal(open, X) :- !, X is inf.
ordinal(V, X) :- date_text(V), parse_time(V, iso_8601, S), X is S * 1000.

rt_cmp(equal, A, B) :- !, ( date_text(A), date_text(B) -> ordinal(A, X), ordinal(B, Y), X =:= Y ; A == B ).
rt_cmp(not_equal, A, B) :- !, \+ rt_cmp(equal, A, B).
rt_cmp(W, A, B) :- ordinal(A, X), ordinal(B, Y), rt_num(W, X, Y).
rt_num(above, X, Y) :- X > Y.
rt_num(below, X, Y) :- X < Y.
rt_num(at_least, X, Y) :- X >= Y.
rt_num(at_most, X, Y) :- X =< Y.

rt_order(before, A, B) :- ordinal(A, X), ordinal(B, Y), X < Y.
rt_order(after, A, B) :- ordinal(A, X), ordinal(B, Y), X > Y.
rt_order(same_time, A, B) :- ordinal(A, X), ordinal(B, Y), X =:= Y.

% compute (DS004 "Exact arithmetic"): integers and exact rationals (decimals are read as rationals, 0.1 is 1r10), never floats. Division is
% rdiv, so 1 divided_by 3 is the rational 1r3 and 0.1 plus 0.2 is exactly 3r10. whole_divided_by and modulo take integers (truncating
% division, the remainder has the sign of the dividend); power takes an integer exponent 0..64; rounded_to is half away from zero;
% minimum_with and maximum_with give the smaller or the larger value.
% A zero divisor, a non-number, an unsafe magnitude or an exponent out of range makes the body false and is noted.
rt_compute(W, A, B, R) :-
    (   rational(A), rational(B), rt_arith(W, A, B, R0), rt_safe(R0)
    ->  R = R0
    ;   note(arithmetic_undefined), fail
    ).
rt_arith(plus, A, B, R) :- R is A + B.
rt_arith(minus, A, B, R) :- R is A - B.
rt_arith(times, A, B, R) :- R is A * B.
rt_arith(divided_by, A, B, R) :- B =\= 0, R is A rdiv B.
rt_arith(whole_divided_by, A, B, R) :- integer(A), integer(B), B =\= 0, R is truncate(A rdiv B).
rt_arith(modulo, A, B, R) :- integer(A), integer(B), B =\= 0, R is A rem B.
rt_arith(power, A, B, R) :- integer(B), B >= 0, B =< 64, R is A ^ B.
rt_arith(rounded_to, A, B, R) :- B > 0, R is round(A rdiv B) * B.
rt_arith(rounded_up_to, A, B, R) :- B > 0, R is ceiling(A rdiv B) * B.
rt_arith(rounded_down_to, A, B, R) :- B > 0, R is floor(A rdiv B) * B.
rt_arith(minimum_with, A, B, R) :- R is min(A, B).
rt_arith(maximum_with, A, B, R) :- R is max(A, B).
rt_safe(R) :- rational(R), R =< 9007199254740991, R >= -9007199254740991.
safe_int(R) :- integer(R), R =< 9007199254740991, R >= -9007199254740991.

% ------------------------------------------------------------------------------------------------ aggregates

% Rows is a sorted set of row lists; GIdx the positions of the group variables. Groups is a list of Key-Members.
rt_groups(Rows, GIdx, Groups) :-
    findall(K-R, ( member(R, Rows), rt_pick(GIdx, R, K) ), Pairs),
    keysort(Pairs, Sorted),
    group_pairs_by_key(Sorted, Groups).
rt_pick([], _, []).
rt_pick([I|Is], R, [V|Vs]) :- nth0(I, R, V), rt_pick(Is, R, Vs).

rt_agg_fn(count, _, Members, N) :- !, length(Members, N).
rt_agg_fn(collect, F, Members, S) :- !, findall(V, (member(M, Members), nth0(F, M, V)), Vs0), sort(Vs0, Vs1), predsort(rt_order_value, Vs1, Vs), rt_json_list(Vs, S).
rt_agg_fn(Fn, F, Members, R) :-
    findall(V, (member(M, Members), nth0(F, M, V)), Vs),
    include(rational, Vs, Ints),
    (   Ints \== Vs -> note(aggregate_non_integer_ignored) ; true ),
    Ints \== [],
    (   Fn == sum -> sum_list(Ints, R)
    ;   Fn == min -> min_list(Ints, R)
    ;   Fn == max -> max_list(Ints, R)
    ),
    rt_safe(R).

% collect orders numbers numerically and anything else by its text (a deliberate copy of the JavaScript rule of the oracle)
rt_order_value(O, A, B) :- rational(A), rational(B), !, compare(O, A, B).
rt_order_value(O, A, B) :- atom_string(A, SA), atom_string(B, SB), compare(O0, SA, SB), ( O0 == (=) -> compare(O, A, B) ; O = O0 ).
rt_json_list(Vs, S) :- maplist(rt_json_item, Vs, Is), atomic_list_concat(Is, ',', Body), atomic_list_concat(['[', Body, ']'], S).
rt_json_item(V, T) :- integer(V), !, T = V.
rt_json_item(V, T) :- rational(V), !, rt_decimal(V, N), format(atom(T), '~15g', [N]).
rt_json_item(V, T) :- atom_string(V, S), with_output_to(atom(T), json_write(current_output, S)).

% ------------------------------------------------------------------------------------------------ generic access to the tables

rt_pred(pos, P, Name) :- atom_concat(p_, P, Name).
rt_pred(neg, P, Name) :- atom_concat(n_, P, Name).

% a goal over the (tabled) evidence of a literal; the predicates are in the generated program
rt_call(Pol, P, Args) :- rt_pred(Pol, P, Name), rt_goal(Name, Args, G), call(G).
rt_goal(Name, Args, G) :- ( Args == [] -> G = Name ; G =.. [Name|Args] ).

rt_holds(Pol, P, Args) :- once(rt_call(Pol, P, Args)).

% evaluate one leaf (data form) against the completed tables; Prems0 -> Prems accumulates the premises of the instance
rt_leaf(l(pos, P, A), Ps0, [l(pos, P, A)|Ps0]) :- rt_call(pos, P, A).
rt_leaf(l(not, P, A), Ps0, [l(neg, P, A)|Ps0]) :- rt_call(neg, P, A).
rt_leaf(l(absent, P, A), Ps0, [absent(P, A)|Ps0]) :- \+ rt_call(pos, P, A).
rt_leaf(l(cmp, W, A, B), Ps, Ps) :- rt_cmp(W, A, B).
rt_leaf(l(compute, W, O, A, B), Ps, Ps) :- rt_compute(W, A, B, R), O = R.
rt_leaf(l(order, W, A, B), Ps, Ps) :- rt_order(W, A, B).
rt_leaf(l(timeof, Which, O, P, A), Ps0, [l(pos, P, A)|Ps0]) :- rt_stored(P, A, F, T), ( Which == start_of -> O = F ; O = T ).
rt_leaves([], Ps, Ps).
rt_leaves([L|Ls], Ps0, Ps) :- rt_leaf(L, Ps0, Ps1), rt_leaves(Ls, Ps1, Ps).

rt_stored(P, A, F, T) :- atom_concat(st_, P, Name), append(A, [F, T], As), G =.. [Name|As], call(G).

% ------------------------------------------------------------------------------------------------ derivation heights and proofs
%
% The HEIGHT of an atom is 0 for a stored fact, else 1 + the largest height of the derived atoms the premises of its cheapest rule
% instance rest on: the round at which the oracle's naive evaluation derives it, and the depth of its explanation. The generated proof
% variant (proofs.mjs) computes it natively: hp_<rel>(Args, H) / hn_<rel>(Args, H), tabled in the `min` mode. A proof is built from
% minimal-height instances (a premise of height <= H-1), so the heights strictly decrease along every premise edge: the node graph is
% acyclic and an explanation is the shortest derivation.

:- dynamic rt_hpred/3.
:- discontiguous rt_hpred/3.

% rt_instance(+Lit, -Kind, -Ref, -Binding, -Premises): one derivation step of a literal by a rule or an aggregate
rt_instance(l(Pol, P, A), rule, ref(Id, Ver, RuleId), Binding, Prems) :-
    ( Pol == neg -> Neg = true ; Neg = false ),
    rt_rule(Id, Ver, RuleId, Neg, P, A, Leaves, Vars),
    rt_leaves(Leaves, [], Rev), reverse(Rev, Prems),
    rt_binding(Vars, Binding).
rt_instance(l(pos, P, A), aggregate, ref(Id, Ver, Id), Binding, Prems) :-
    rt_agg(Id, Ver, P, A, GroupVars, Vars),
    rt_agg_rows(Id, GroupVars, Prems),
    rt_binding(Vars, Binding).

rt_binding(Vars, Binding) :- findall(N-V, (member(N=V, Vars), nonvar(V)), Binding).

% the minimal height of a literal that holds
rt_height(l(Pol, P, A), 0) :- rt_fact(Pol, P, A, _, _, _, _), !.
rt_height(l(Pol, P, A), H) :-
    rt_hpred(Pol, P, Name),
    append(A, [H0], A1), G =.. [Name|A1], call(G), !, H = H0.

rt_prems_below(Prems, Max) :- forall(( member(Pr, Prems), Pr = l(_, _, _) ), ( rt_height(Pr, H), H =< Max )).

% rt_prove(+Lit): assert the node of a literal (once) and of everything below it, a minimal-height proof
rt_prove(L) :- rt_node(L, _, _, _, _), !.
rt_prove(L) :-
    L = l(Pol, P, A),
    rt_height(L, H),
    (   H =:= 0
    ->  once(rt_fact(Pol, P, A, Id, Ver, Status, Speaker)),
        rt_count_node,
        assertz(rt_node(L, fact, ref(Id, Ver, Id), [Status, Speaker], []))
    ;   H1 is H - 1,
        once(( rt_instance(L, Kind, Ref, Binding, Prems), rt_prems_below(Prems, H1) )),
        rt_count_node,
        assertz(rt_node(L, Kind, Ref, Prems, Binding)),
        forall(( member(Pr, Prems), Pr = l(_, _, _) ), rt_prove(Pr))
    ).

rt_prove_any(L, _) :- rt_prove(L).

% a proof is bounded: a huge answer set (a closure over a long chain has quadratically many proof nodes) would spend its time here, so
% past the cap the proofs are dropped and the answer says `used_incomplete` (under-reporting `used` only loses proof-use promotions)
rt_proof_cap(4000).
:- dynamic rt_proof_nodes/1.
rt_proof_nodes(0).
rt_count_node :-
    retract(rt_proof_nodes(N)), N1 is N + 1, assertz(rt_proof_nodes(N1)),
    rt_proof_cap(Cap),
    ( N1 > Cap -> throw(rt_proof_cap) ; true ).

% ------------------------------------------------------------------------------------------------ output

rt_val(V, J) :- integer(V), !, J = V.
rt_val(V, J) :- rational(V), !, rt_decimal(V, J).
rt_val(V, J) :- atom(V), !, atom_string(V, J).
rt_val(V, J) :- string(V), !, J = V.
rt_vals(Vs, Js) :- maplist(rt_val, Vs, Js).

% an exact rational as a JSON number: a terminating decimal is the nearest double of its exact value; a quotient that does not terminate
% (1r3) is rendered as the oracle does, to 12 significant digits, and said so in the notes
rt_decimal(V, J) :-
    rational(V, _, D0),
    rt_strip(D0, 2, D1), rt_strip(D1, 5, D),
    X is float(V),
    (   D =:= 1 -> J = X
    ;   note(rational_rounded_12_digits), format(atom(A), '~11e', [X]), atom_number(A, J)
    ).
rt_strip(D, P, R) :- ( D mod P =:= 0 -> D1 is D // P, rt_strip(D1, P, R) ; R = D ).

rt_lit_json(l(Pol, P, A), _{neg: Neg, p: P, args: Js}) :- ( Pol == neg -> Neg = true ; Neg = false ), rt_vals(A, Js).
rt_lit_json(absent(P, A), _{absent: _{p: P, args: Js}}) :- rt_vals(A, Js).

rt_node_json(_{lit: LJ, kind: Kind, ref: _{id: Id, version: Ver}, rule_id: RId, premises: PJ, binding: BJ, status: St, speaker: Sp}) :-
    rt_node(L, Kind0, ref(Id, Ver, RId), Extra, Binding),
    rt_lit_json(L, LJ),
    ( Kind0 == fact -> Kind = fact, Extra = [St0, Sp0], PJ = [], atom_string(St0, St), ( Sp0 == null -> Sp = null ; rt_val(Sp0, Sp) )
    ; Kind = Kind0, St = "observed", Sp = null, maplist(rt_lit_json, Extra, PJ) ),
    findall(K-J, (member(K-V, Binding), rt_val(V, J)), BP),
    dict_pairs(BJ, _, BP).

rt_nodes_json(Nodes) :- findall(J, rt_node_json(J), Nodes).

rt_emit(Outcome, Result) :-
    findall(N, rt_note(N), Notes),
    (   Outcome == done -> Dict = _{status: done, result: Result, notes: Notes}
    ;   Dict = _{status: Outcome, notes: Notes}
    ),
    json_write_dict(current_output, Dict, [width(0)]), nl.

% run the generated task under the inference budget (the first argument is informational: the wall limit is the host's)
rt_run(_Wall, Infer) :-
    catch(( call_with_inference_limit(rt_task(Result), Infer, R00) -> R0 = R00 ; R0 = error(task_failed) ),
          Err, ( R0 = error(Err) )),
    (   R0 == inference_limit_exceeded -> Outcome = probes
    ;   R0 = error(E) -> Outcome = error, print_message(error, E)
    ;   Outcome = done
    ),
    (   Outcome == done -> true ; abolish_all_tables ),
    (   Outcome == error -> Out = error ; Out = Outcome ),
    rt_emit(Out, Result).

% ------------------------------------------------------------------------------------------------ why_not: an abductive meta-interpreter
%
% Runs over the completed evidence (the closure is known) and the rule data, NOT over the tabled predicates: an abductive
% meta-interpreter does not compose with tabling (it loses termination unless tabled itself). It returns the inclusion-minimal
% sets of base atoms whose ADDITION would make the goal derivable, plus the blockers. Same definition as the oracle (whynot.mjs).
%
%   alternatives are ordered sets of lit(Neg, P, Args) terms; a literal already derivable costs nothing;
%   a missing literal is explained by adding it (if abducible) or by a rule whose head matches, recursively, never through a
%   literal being explained (cycles are cut); a body atom with unbound variables is matched against the evidence that exists
%   first, and only when nothing matches are its variables grounded over the constants of the slice; absent / not / compare
%   that fail kill the instance, and the atom that holds is a blocker.

:- dynamic wn_blocker/3.

wn_max(2000).

wn_goal(Alts, Sets) :-
    retractall(wn_blocker(_, _, _)),
    findall(S, ( member(Leaves, Alts), wn_body(Leaves, [], S) ), Sets0),
    sort(Sets0, Sets1),
    wn_minimal(Sets1, Sets).

wn_minimal(Sets, Min) :- include(wn_is_minimal(Sets), Sets, Min).
wn_is_minimal(Sets, S) :- \+ ( member(O, Sets), O \== S, length(O, LO), length(S, LS), LO < LS, ord_subset(O, S) ).

% wn_body(+Leaves, +Path, -Set): non-deterministic over the alternatives of the body
wn_body([], _, []).
wn_body([L|Ls], Path, Set) :-
    wn_leaf(L, Path, S1),
    wn_body(Ls, Path, S2),
    ord_union(S1, S2, Set).

% wn_leaf(+Leaf, +Path, -Set): the alternatives of one leaf (bindings flow to the leaves that follow)
wn_leaf(l(cmp, W, A, B), _, []) :- rt_cmp(W, A, B).
wn_leaf(l(order, W, A, B), _, []) :- rt_order(W, A, B).
wn_leaf(l(compute, W, O, A, B), _, []) :- rt_compute(W, A, B, R), O = R.
wn_leaf(l(absent, P, A), _, []) :-
    (   rt_holds(pos, P, A) -> wn_blocker_note(pos, P, A, absent_fails), fail ; true ).
wn_leaf(l(Mode, P, A), Path, Set) :-
    memberchk(Mode, [pos, not]),
    ( Mode == pos -> Pol = pos ; Pol = neg ),
    (   ground(A)
    ->  wn_literal(Pol, P, A, Path, Set)
    ;   wn_open(Pol, P, A, Path, Set)
    ).

wn_open(Pol, P, A, Path, Set) :-
    findall(A, rt_call(Pol, P, A), Matches),
    (   Matches \== []
    ->  member(A, Matches), Set = []
    ;   term_variables(A, Free),
        wn_ground_free(Free, P, A, 0),
        wn_literal(Pol, P, A, Path, Set)
    ).

% ground the free variables over the typed domain of their first position
wn_ground_free([], _, _, _).
wn_ground_free([V|Vs], P, A, _) :-
    nth0(I, A, T), T == V, !,
    rt_domain(P, I, Dom), member(V, Dom),
    wn_ground_free(Vs, P, A, 0).

% wn_literal(+Pol, +P, +GroundArgs, +Path, -Set): the alternatives that make the literal hold
wn_literal(Pol, P, A, Path, Set) :-
    Key = k(Pol, P, A),
    \+ memberchk(Key, Path),
    (   rt_holds(Pol, P, A) -> Set = []
    ;   wn_explain(Pol, P, A, [Key|Path], Set)
    ).

wn_explain(Pol, P, A, Path, Set) :-
    (   wn_abducible(P), ( Pol == pos -> Set = [lit(false, P, A)] ; Set = [lit(true, P, A)] ),
        ( Pol == pos -> OPol = neg ; OPol = pos ),
        wn_blocker_note(OPol, P, A, contradicts)
    ;   ( Pol == neg -> Neg = true ; Neg = false ),
        rt_rule(_, _, _, Neg, P, HA, Leaves, _),
        copy_term(HA-Leaves, HA1-Leaves1),
        HA1 = A,
        wn_body(Leaves1, Path, Set)
    ).

wn_abducible(P) :- \+ sub_atom(P, 0, _, _, x_), ( \+ rt_derived(P) ; rt_fact(_, P, _, _, _, _, _) ), !.

wn_blocker_note(Pol, P, A, Why) :-
    (   rt_holds(Pol, P, A)
    ->  ( wn_blocker(Why, l(Pol, P, A), _) -> true ; assertz(wn_blocker(Why, l(Pol, P, A), _)) )
    ;   true
    ).

% ------------------------------------------------------------------------------------------------ abduction by hypothesis subsets

:- dynamic rt_on/1.

% subsets of the hypothesis ids by size; a superset of an explanation already found is skipped (inclusion-minimal sets)
rt_abduce(Ids, Goal, MaxSize, Found) :-
    rt_abduce_sizes(0, Ids, Goal, MaxSize, [], Found).

rt_abduce_sizes(K, Ids, Goal, Max, Acc, Found) :-
    (   K > Max -> reverse(Acc, Found)
    ;   findall(S, rt_subset_of_size(K, Ids, S), Subs),
        foldl(rt_try_subset(Goal), Subs, Acc, Acc1),
        (   K =:= 0, Acc1 \== [] -> reverse(Acc1, Found)
        ;   K1 is K + 1, rt_abduce_sizes(K1, Ids, Goal, Max, Acc1, Found)
        )
    ).

rt_subset_of_size(0, _, []) :- !.
rt_subset_of_size(K, Ids, [H|T]) :- K > 0, append(_, [H|Rest], Ids), K1 is K - 1, rt_subset_of_size(K1, Rest, T).

rt_try_subset(Goal, Subset, Acc, Out) :-
    (   member(F, Acc), subset(F, Subset) -> Out = Acc
    ;   rt_holds_with(Subset, Goal) -> Out = [Subset|Acc]
    ;   Out = Acc
    ).

rt_holds_with(Subset, Goal) :-
    retractall(rt_on(_)),
    forall(member(S, Subset), assertz(rt_on(S))),
    abolish_all_tables,
    once(call(Goal)).

% ------------------------------------------------------------------------------------------------ small helpers of generated code

rt_envget(Env, K, V) :- ( memberchk(K-V0, Env) -> V = V0 ; true ).
rt_hmax(Hs, M) :- max_list([0|Hs], M).
rt_env_json(Env, J) :- findall(K-V1, (member(K-V, Env), rt_val(V, V1)), Ps), dict_pairs(J, _, Ps).
