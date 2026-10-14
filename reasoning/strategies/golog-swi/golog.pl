% golog-swi: a small Golog interpreter and a trace evaluator for the modes of work, in SWI-Prolog.
% Loaded after ../prolog-tabling/runtime.pl (the leaf evaluator rt_leaves/3, the value helpers).
%
% THE WORLD. A state is a sorted list of literals l(pos|neg, Pred, Args) (polarity-explicit: a fluent that is open has no truth
% without evidence; for a CLOSED fluent `not p` is absence). The derived relations are the tabled program generated from the rules
% in force (prolog-tabling codegen, state mode): p_<rel>(Args) :- rt_st(pos, rel, Args) plus the rule clauses. Loading a state
% (gl_load/1) replaces the rt_st facts and abolishes the tables, so every query sees the closure of exactly that state. All state
% queries are findall/once based: no tabled goal is left open across a state change.
%
% THE PROGRAM. A method is a Golog program: seq, choose (nondeterministic choice), optional, any_order, if (a test), until ... max N
% (a bounded loop), pick (nondeterministic binding), a primitive step (an action: its preconditions are TESTS on the state, its
% effects transform the state) and a sub-task (a call of a method that achieves it). The interpreter chooses only at the choice
% points; every complete run is a legal execution of the program. There is no blind search: a goal that no approved method
% achieves is not expressible here.
%
% THE NORMS are tests on the primitive actions of a run, evaluated over the complete run (gl_eval/7, the definitions of proposal 8.2):
% the same function judges a plan and a recorded trace, so planning and auditing cannot disagree.
%
% Data predicates (written by index.mjs, one clause each, variables shared inside a clause):
%   rt_init(State)                          the initial state
%   rt_action(Id, Ver, Cost, Params, Leaves, Adds, Rems)     Adds, Rems: eff(NegBool, Pred, Args)
%   rt_method(Id, Ver, Binding, Cost, OnFailure, HeadPred, HeadTerms, Guard, Body)     Guard: alternatives of ordered leaves
%   rt_norm(Id, Ver, Modality, Pat, Qual, Standing, Severity, Cost, Priority, Binding, Message, PatVars, WhenBound, WhenFree, WhenState)
%   rt_edge(OverId, TargetId), rt_goal(Alternatives), rt_goal_consts(List), rt_closed(Pred)

:- dynamic rt_st/3, gl_loaded/1, gl_capped/2, gl_nodes/1, gl_fail/6.
:- dynamic rt_action/7, rt_method/9, rt_norm/15, rt_edge/2, rt_init/1, rt_goal/1, rt_goal_consts/1.
:- discontiguous rt_action/7, rt_method/9, rt_norm/15, rt_edge/2, rt_init/1, rt_goal/1, rt_goal_consts/1.
:- discontiguous gl_one_norm/6.

% ------------------------------------------------------------------------------------------------ states

gl_load(S) :-
    (   gl_loaded(K), K == S -> true
    ;   retractall(rt_st(_, _, _)),
        forall(member(l(Pol, P, A), S), assertz(rt_st(Pol, P, A))),
        abolish_all_tables,
        retractall(gl_loaded(_)), assertz(gl_loaded(S))
    ).

gl_leaves_in(S, Leaves) :- gl_load(S), rt_leaves(Leaves, [], _).

% the first alternative (a list of leaves) that holds in the state; its first solution's bindings stay
gl_first(S, Alts) :-
    member(Leaves, Alts),
    findall(Leaves, gl_leaves_in(S, Leaves), [Leaves1|_]),
    Leaves = Leaves1, !.

gl_holds(S, Alts) :- once(( member(Leaves, Alts), gl_leaves_in(S, Leaves) )).

gl_add(S, L, S1) :- ( memberchk(L, S) -> S1 = S ; sort([L|S], S1) ).
gl_del(S, L, S1) :- ( selectchk(L, S, S0) -> S1 = S0 ; S1 = S ).

% effects: removes first, then adds (an atom both removed and added ends up present); removing a positive literal of an OPEN fluent
% records its negative literal
gl_effect(S0, Adds, Rems, S) :- foldl(gl_remove, Rems, S0, S1), foldl(gl_adds, Adds, S1, S).
gl_remove(eff(Neg, P, A), S0, S) :-
    ( Neg == true -> Pol = neg ; Pol = pos ),
    gl_del(S0, l(Pol, P, A), S1),
    (   Pol == pos, \+ rt_closed(P) -> gl_add(S1, l(neg, P, A), S) ; S = S1 ).
gl_adds(eff(Neg, P, A), S0, S) :-
    ( Neg == true -> Pol = neg, Op = pos ; Pol = pos, Op = neg ),
    gl_add(S0, l(Pol, P, A), S1),
    gl_del(S1, l(Op, P, A), S).

% ------------------------------------------------------------------------------------------------ the interpreter
% a context is c(State, StepsRev, StatesRev, DecisionsRev, Cost)

gx(seq([]), C, C) :- !.
gx(seq([X|Xs]), C0, C) :- !, gx(X, C0, C1), gx(seq(Xs), C1, C).
gx(choose(Bs), c(S, St, Sts, Ds, Co), C) :- !,
    gl_branch_names(Bs, Names),
    nth1(I, Bs, B), nth1(I, Names, Chosen),
    length(St, Step0), Step is Step0 + 1,
    gx(B, c(S, St, Sts, [ch(choose, Step, Chosen, Names)|Ds], Co), C).
gx(optional(X), c(S, St, Sts, Ds, Co), C) :- !,
    length(St, Step0), Step is Step0 + 1,
    gl_branch_names([X], [Name]),
    (   gx(X, c(S, St, Sts, [ch(optional, Step, Name, [Name, skip])|Ds], Co), C)
    ;   C = c(S, St, Sts, [ch(optional, Step, skip, [Name, skip])|Ds], Co)
    ).
gx(any_order(Xs), c(S, St, Sts, Ds, Co), C) :- !,
    permutation(Xs, Ps),
    length(St, Step0), Step is Step0 + 1,
    gl_branch_names(Ps, [First|_]), gl_branch_names(Xs, Names),
    gx(seq(Ps), c(S, St, Sts, [ch(any_order, Step, First, Names)|Ds], Co), C).
gx(if(Alts, Then, Else), C0, C) :- !,
    C0 = c(S, _, _, _, _),
    (   gl_first(S, Alts) -> gx(seq(Then), C0, C) ; gx(seq(Else), C0, C) ).
gx(until(Alts, Max, Body), C0, C) :- !, gx_until(Alts, Max, 0, Body, C0, C).
gx(pick(Leaf), C0, C) :- !,
    C0 = c(S, _, _, _, _),
    findall(Leaf, gl_leaves_in(S, [Leaf]), Ls), member(Leaf, Ls), C = C0.
gx(prim(A, Args), c(S, St, Sts, Ds, Co), c(S1, [step(A, Args, Ver, Cost)|St], [S1|Sts], Ds, Co1)) :- !,
    rt_action(A, Ver, Cost, Params, Leaves, Adds, Rems),
    Params = Args,
    findall(Params-Adds-Rems, gl_leaves_in(S, Leaves), Sols),
    (   Sols == [] -> gl_note_fail(S, St, A, Args, Leaves), fail ; true ),
    member(Params-Adds-Rems, Sols),
    ground(Params),
    gl_effect(S, Adds, Rems, S1),
    Co1 is Co + Cost,
    gl_count_node.
gx(task(P, Args), C0, C) :- !, gx_method(_, P, Args, C0, C).

% the names of the branches of a choice: a primitive step is named by its action and arguments, anything else by its kind
gl_branch_names([], []).
gl_branch_names([B|Bs], [N|Ns]) :- ( B = prim(A, Args) -> N = prim(A, Args) ; functor(B, F, _), N = F ), gl_branch_names(Bs, Ns).

% a step that cannot be performed: remember the first unmet requirement, at the depth (number of steps done) it was reached
gl_note_fail(S, St, A, Args, Leaves) :-
    ground(Args),
    length(St, Depth),
    gl_load(S),
    (   member(l(Mode, P, PA), Leaves), ground(PA), \+ gl_leaf_ok(Mode, P, PA)
    ->  assertz(gl_fail(Depth, A, Args, Mode, P, PA))
    ;   true ).
gl_note_fail(_, _, _, _, _).

gx_until(Alts, Max, N, Body, C0, C) :-
    C0 = c(S, _, _, _, _),
    (   gl_first(S, Alts) -> C = C0
    ;   N >= Max -> assertz(gl_capped(until, Max)), fail
    ;   N1 is N + 1, gx(seq(Body), C0, C1), gx_until(Alts, Max, N1, Body, C1, C)
    ).

% invoke a method (a given one when Id is bound): its head unifies with the task, its guard holds in the current state
gx_method(Id, P, Args, c(S, St, Sts, Ds, Co), C) :-
    rt_method(Id, Ver, _Bind, MCost, _OnF, P, Args, Guard, Body),
    gl_holds(S, Guard),
    Co1 is Co + MCost,
    gx(seq(Body), c(S, St, Sts, [d(Id, Ver)|Ds], Co1), C).

gl_count_node :- ( retract(gl_nodes(N)) -> true ; N = 0 ), N1 is N + 1, assertz(gl_nodes(N1)).

% candidates: the methods whose head matches the task and whose guard holds in the initial state (in clause order, once each)
gl_candidates(P, Args, Ids) :-
    rt_init(S0),
    findall(Id, ( rt_method(Id, _, _, _, _, P, Args, Guard, _), gl_holds(S0, Guard) ), Ids0),
    gl_dedup(Ids0, Ids).

gl_dedup(L, U) :- gl_dedup_(L, [], U).
gl_dedup_([], _, []).
gl_dedup_([X|Xs], Seen, Out) :- ( memberchk(X, Seen) -> Out = Rest ; Out = [X|Rest] ), gl_dedup_(Xs, [X|Seen], Rest).

% all complete runs of the task through one method (the goal must hold at the end), with their norm evaluation
gl_runs(Id, P, Args, Max, Runs, Capped, Nodes) :-
    rt_init(S0),
    retractall(gl_capped(_, _)), retractall(gl_nodes(_)), retractall(gl_fail(_, _, _, _, _, _)), assertz(gl_nodes(0)),
    findall(R, gl_run_of(Id, P, Args, S0, Max, R), Runs),
    ( gl_capped(Kind, N) -> Capped = capped(Kind, N) ; Capped = none ),
    gl_nodes(Nodes).

gl_run_of(Id, P, Args, S0, Max, run(Decs, Steps, States, Cost, Eval)) :-
    gx_method(Id, P, Args, c(S0, [], [S0], [], 0), c(SF, StRev, StsRev, DsRev, Cost)),
    gl_nodes(N),
    (   N > Max -> assertz(gl_capped(nodes, Max)), !, fail ; true ),
    ( rt_goal(Alts) -> gl_holds(SF, Alts) ; true ),
    reverse(StRev, Steps), reverse(StsRev, States), reverse(DsRev, Decs),
    gl_goal_consts(GC),
    gl_eval(Steps, States, GC, true, null, all, Eval).

gl_goal_consts(GC) :- ( rt_goal_consts(GC0) -> GC = GC0 ; GC = [] ).

% ------------------------------------------------------------------------------------------------ norms over a run
%
% A run has steps 1..n (step(Action, Args, Version, Cost)) and states 0..n (state i is the state after step i; step i is performed in
% state i-1). InF is `all` or a list of Id-[indices] (the steps at which a wire is in force; state 0 takes the time of step 1).
%   forbid ~a       an occurrence at step i whose `when` holds in state i-1 and that no override blocks; `before ~b` only while no b has
%                   occurred at a step < i, `after ~b` only once one has, `at_most_once` from the second occurrence on;
%   forbid ATOM     the atom holds with `when` in some state m (the initial state included);
%   oblige          an instance is triggered at the first state k where `when` holds for a binding whose values are relevant (the goal's
%                   constants or parameters of steps <= k+1; `standing` waives the test), then sometime / within N / before ~b /
%                   after ~b / always.
% Each norm instance is violated at most once, at its first step. Unmet obligations at the end are violations when Final is true.

gl_in(all, _, _) :- !.
gl_in(InF, Id, I) :- memberchk(Id-L, InF), memberchk(I, L).

gl_norm(Id, n(Id, Ver, Mod, Pat, Qual, Standing, Sev, Cost, Bind, Msg, PV, WB, WF, WS, Prio)) :-
    rt_norm(Id, Ver, Mod, Pat, Qual, Standing, Sev, Cost, Prio, Bind, Msg, PV, WB, WF, WS).

gl_eval(Steps, States, GC, Final, Days, InF, res(Vs, Trig, Used, Unsc)) :-
    length(Steps, N),
    findall(Id, rt_norm(Id, _, _, _, _, _, _, _, _, _, _, _, _, _, _), Ids),
    foldl(gl_norm_eval(ev(Steps, States, N, GC, Final, Days, InF)), Ids, r([], [], [], []), r(Vs, Trig, Used0, Unsc0)),
    sort(Used0, Used), sort(Unsc0, Unsc).

gl_norm_eval(Ctx, Id, r(V0, T0, U0, S0), r(V, T, U, S)) :-
    gl_norm(Id, N),
    (   N = n(_, _, permit, _, _, _, _, _, _, _, _, _, _, _, _)
    ->  V = V0, T = T0, U = U0, S = S0
    ;   gl_one_norm(N, Ctx, V1, T1, U1, S1),
        append(V0, V1, V), append(T0, T1, T), append(U0, U1, U), append(S0, S1, S)
    ).

viol(n(Id, Ver, _, _, _, _, Sev, Cost, Bind, Msg, _, _, _, _, _), Values, Step, Why, v(Id, Ver, Sev, Bind, C, Values, Step, Why, Msg)) :-
    ( Sev == soft -> C = Cost ; C = 0 ).

key_of(Id, Values, Key) :- atomic_list_concat([Id|Values], ' ', Key).

% ---- forbid over an action pattern
gl_one_norm(N, Ctx, Vs, [], Used, []) :-
    N = n(Id, _, forbid, pat(action, A, Terms), Qual, _, _, _, _, _, PV, WB, _, _, _), !,
    Ctx = ev(Steps, States, Nn, _, _, _, InF),
    gl_fa(1, Nn, Steps, States, InF, N, A, Terms, Qual, PV, WB, [], [], Vs, Used0),
    ( Used0 == [] -> Used = [] ; Used = [Id|Used0] ).

gl_fa(I, Nn, _, _, _, _, _, _, _, _, _, _, _, [], []) :- I > Nn, !.
gl_fa(I, Nn, Steps, States, InF, N, A, Terms, Qual, PV, WB, Done0, Occ0, Vs, Used) :-
    nth1(I, Steps, step(Act, Args, _, _)),
    N = n(Id, _, _, _, _, _, _, _, _, _, _, _, _, _, _),
    I1 is I + 1,
    (   Act == A, length(Terms, L), length(Args, L), gl_in(InF, Id, I),
        copy_term(Terms-PV-WB, Terms1-PV1-WB1), Terms1 = Args,
        I0 is I - 1, nth0(I0, States, SPrev), gl_holds(SPrev, WB1)
    ->  Values = PV1,
        (   gl_overrider(Id, I, Act, Args, States, InF, By)
        ->  gl_fa(I1, Nn, Steps, States, InF, N, A, Terms, Qual, PV, WB, Done0, Occ0, Vs, Used1), Used = [Id, By|Used1]
        ;   gl_fa_qual(Qual, I, Steps, Occ0, Occ1, Values, Id, Skip),
            key_of(Id, Values, Key),
            (   ( Skip == true ; memberchk(Key, Done0) )
            ->  gl_fa(I1, Nn, Steps, States, InF, N, A, Terms, Qual, PV, WB, Done0, Occ1, Vs, Used1), Used = [Id|Used1]
            ;   viol(N, Values, I, 'forbidden step performed', V),
                gl_fa(I1, Nn, Steps, States, InF, N, A, Terms, Qual, PV, WB, [Key|Done0], Occ1, Vs1, Used1),
                Vs = [V|Vs1], Used = [Id|Used1]
            )
        )
    ;   gl_fa(I1, Nn, Steps, States, InF, N, A, Terms, Qual, PV, WB, Done0, Occ0, Vs, Used)
    ).

% qualifier gate of a forbidden step occurrence at step I: Skip = true when the qualifier excuses it
gl_fa_qual(q(always), _, _, Occ, Occ, _, _, false).
gl_fa_qual(q(before, B), I, Steps, Occ, Occ, _, _, Skip) :- ( gl_named_before(B, I, Steps) -> Skip = true ; Skip = false ).
gl_fa_qual(q(after, B), I, Steps, Occ, Occ, _, _, Skip) :- ( gl_named_before(B, I, Steps) -> Skip = false ; Skip = true ).
gl_fa_qual(q(at_most_once), _, _, Occ0, Occ, Values, Id, Skip) :-
    key_of(Id, Values, Key),
    ( select(Key-C0, Occ0, Rest) -> true ; C0 = 0, Rest = Occ0 ),
    C is C0 + 1, Occ = [Key-C|Rest],
    ( C < 2 -> Skip = true ; Skip = false ).

% an occurrence of the action B at a step j < I
gl_named_before(B, I, Steps) :- nth1(J, Steps, step(B, _, _, _)), J < I, !.

% the norm that overrides this one for step I (its pattern matches the same action, its `when` holds before the step)
gl_overrider(Id, I, Act, Args, States, InF, By) :-
    rt_edge(Over, Id),
    gl_norm(Over, n(Over, _, _, pat(action, Act, Terms), _, _, _, _, _, _, PV, WB, _, _, _)),
    gl_in(InF, Over, I),
    copy_term(Terms-PV-WB, Terms1-_-WB1), length(Terms1, L), length(Args, L), Terms1 = Args,
    I0 is I - 1, nth0(I0, States, SPrev), gl_holds(SPrev, WB1),
    By = Over, !.

% ---- forbid over a state atom (derived relations count: the closure of each state is tested)
gl_one_norm(N, Ctx, Vs, [], Used, []) :-
    N = n(Id, _, forbid, pat(state, _, _), Qual, _, _, _, _, _, PV, _, _, WS, _), !,
    Ctx = ev(Steps, States, Nn, _, _, _, InF),
    findall(m(M, Values),
        ( between(0, Nn, M), gl_in(InF, Id, M), gl_state_gate(Qual, M, Steps),
          nth0(M, States, SM), copy_term(PV-WS, Values-WS1),
          gl_alts_in(SM, WS1) ),
        Hits),
    (   Hits == [] -> Used = [], Vs = []
    ;   Used = [Id], gl_fpk(Hits, Id, N, 'forbidden state reached', [], Vs)
    ).

gl_alts_in(S, Alts) :- member(Leaves, Alts), gl_leaves_in(S, Leaves).

gl_state_gate(q(always), _, _).
gl_state_gate(q(before, B), M, Steps) :- \+ ( nth1(J, Steps, step(B, _, _, _)), J =< M ).
gl_state_gate(q(after, B), M, Steps) :- nth1(J, Steps, step(B, _, _, _)), J =< M, !.

gl_fpk([], _, _, _, _, []).
gl_fpk([m(M, Values)|T], Id, N, Why, Seen, Vs) :-
    key_of(Id, Values, Key),
    (   memberchk(Key, Seen) -> gl_fpk(T, Id, N, Why, Seen, Vs)
    ;   viol(N, Values, M, Why, V), Vs = [V|Vs1], gl_fpk(T, Id, N, Why, [Key|Seen], Vs1)
    ).

% ---- oblige
gl_one_norm(N, Ctx, Vs, Trig, Used, Unsc) :-
    N = n(Id, _, oblige, Pat, Qual, Standing, Sev, _, _, _, PV, _, WF, _, _), !,
    Ctx = ev(Steps, States, Nn, GC, Final, Days, InF),
    findall(k(Key, Values, M),
        ( between(0, Nn, M), gl_in(InF, Id, M), nth0(M, States, SM),
          copy_term(PV-WF, Values-WF1), gl_alts_in(SM, WF1),
          ( ground(Values) -> true ; throw(error(norm_unbound_variable(Id), _)) ),
          ( Standing == true -> true ; gl_relevant(Values, M, Steps, GC) ),
          key_of(Id, Values, Key) ),
        Hits),
    gl_first_instances(Hits, [], Insts0), sort(1, @=<, Insts0, Insts),
    (   Insts == [] -> Vs = [], Trig = [], Used = [], Unsc = []
    ;   Used = [Id],
        findall(t(Id, Values, Sev), member(k(_, Values, _), Insts), Trig),
        ( Standing == true, PV \== [] -> Unsc = [Id] ; Unsc = [] ),
        gl_obl_all(Insts, N, Pat, Qual, PV, Steps, States, Nn, Final, Days, Vs)
    ).

% a value is relevant at state M when it is a goal constant or a parameter of a step up to the NEXT one
gl_relevant(Values, M, Steps, GC) :-
    M1 is M + 1, length(Steps, Ln),
    (   Ln >= M1 -> length(Pre, M1), append(Pre, _, Steps) ; Pre = Steps ),
    findall(A, ( member(step(_, Args, _, _), Pre), member(A, Args) ), Used0),
    append(GC, Used0, Rel),
    forall(member(V, Values), memberchk(V, Rel)).

gl_first_instances([], _, []).
gl_first_instances([k(Key, V, M)|T], Seen, Out) :-
    (   memberchk(Key, Seen) -> gl_first_instances(T, Seen, Out)
    ;   Out = [k(Key, V, M)|Rest], gl_first_instances(T, [Key|Seen], Rest)
    ).

gl_obl_all([], _, _, _, _, _, _, _, _, _, []).
gl_obl_all([k(_, Values, K)|T], N, Pat, Qual, PV, Steps, States, Nn, Final, Days, Vs) :-
    gl_obl_outcome(Pat, Qual, Values, PV, K, Steps, States, Nn, Final, Days, Out),
    (   Out = violation(Step, Why) -> viol(N, Values, Step, Why, V), Vs = [V|Vs1] ; Vs = Vs1 ),
    gl_obl_all(T, N, Pat, Qual, PV, Steps, States, Nn, Final, Days, Vs1).

% the steps I >= Lo that perform the obliged action with these values
gl_occ(pat(action, A, Terms), PV, Values, Steps, Lo, Occ) :-
    findall(I, ( nth1(I, Steps, step(A, Args, _, _)), I >= Lo, length(Terms, L), length(Args, L),
                 copy_term(Terms-PV, Terms1-PV1), Terms1 = Args, PV1 == Values ), Occ).

% unmet at the end of the run: a violation when the run is final, else still pending
gl_unmet(Final, Nn, Why, Out) :- ( Final == true -> Out = violation(Nn, Why) ; Out = pending ).

gl_obl_outcome(Pat, Qual, Values, PV, K, Steps, _States, Nn, Final, Days, Out) :-
    Pat = pat(action, _, _), !,
    Lo is max(K + 1, 1),
    gl_occ(Pat, PV, Values, Steps, Lo, Occ),
    (   Qual = q(sometime) ->
        ( Occ \== [] -> Out = met ; gl_unmet(Final, Nn, 'obligation not met by the end', Out) )
    ;   Qual = q(within, Wn) -> gl_within(Days, Wn, K, Occ, Steps, Nn, Final, Out)
    ;   Qual = q(before, B) ->
        findall(J, ( nth1(J, Steps, step(B, _, _, _)), J > K ), Js),
        (   Js = [Bj|_]
        ->  ( ( member(I, Occ), I < Bj ) -> Out = met ; format(atom(W), '~w happened before the obligation was met', [B]), Out = violation(Bj, W) )
        ;   Out = met
        )
    ;   Qual = q(after, B) ->
        findall(J, ( nth1(J, Steps, step(B, _, _, _)), J > K ), Js),
        (   Js == [] -> Out = met
        ;   last(Js, Last),
            (   ( member(I, Occ), I > Last ) -> Out = met
            ;   format(atom(W), 'no follow-up after ~w', [B]), gl_unmet(Final, Nn, W, Out)
            )
        )
    ;   Out = met
    ).
gl_obl_outcome(pat(state, P, Terms), Qual, Values, PV, K, _Steps, States, Nn, Final, _Days, Out) :-
    copy_term(Terms-PV, Terms1-Values),
    HoldsAt = gl_state_has(States, P, Terms1),
    (   Qual = q(always) ->
        ( between(K, Nn, M), \+ call(HoldsAt, M) -> Out = violation(M, 'the state to maintain does not hold') ; Out = met )
    ;   Qual = q(sometime) ->
        (   between(K, Nn, M), call(HoldsAt, M) -> Out = met
        ;   gl_unmet(Final, Nn, 'state never reached', Out) )
    ;   Qual = q(within, Wn) ->
        Hi is min(Nn, K + Wn),
        (   between(K, Hi, M), call(HoldsAt, M) -> Out = met
        ;   Nn >= K + Wn -> D is K + Wn, Out = violation(D, 'state not reached within steps')
        ;   gl_unmet(Final, Nn, 'run ended before the state was reached', Out)
        )
    ;   throw(error(norm_qualifier_unsupported(Qual), _))
    ).

gl_state_has(States, P, Args, M) :- nth0(M, States, S), gl_holds(S, [[l(pos, P, Args)]]).

gl_within(Days, Wn, K, Occ, Steps, Nn, Final, Out) :-
    (   Days \== null
    ->  Kk is max(K, 1), nth0(Kk, Days, Tk),
        (   member(I, Occ), nth0(I, Days, Ti), Ti - Tk =< Wn -> Out = met
        ;   findall(J, ( nth1(J, Steps, _), J > K, nth0(J, Days, Tj), Tj - Tk > Wn ), Late),
            format(atom(W), 'not met within ~w days', [Wn]),
            (   Late = [J0|_] -> Out = violation(J0, W) ; gl_unmet(Final, Nn, W, Out) )
        )
    ;   Deadline is K + Wn,
        (   member(I, Occ), I =< Deadline -> Out = met
        ;   Nn >= Deadline -> format(atom(W), 'not met within ~w steps', [Wn]), Out = violation(Deadline, W)
        ;   gl_unmet(Final, Nn, 'run ended before the obligation was met', Out)
        )
    ).

% ------------------------------------------------------------------------------------------------ method deviation (conformance)
%
% A method is ENGAGED by an instance: a binding A of the variables of its head taken from a trace step that matches one of its
% primitive steps (variables that step does not bind range over the values of the trace). The SCOPE of the instance is the trace steps
% performed while the method is in force that mention a value of A (all steps for a method without variables). The method's guard
% must hold in the state before the first scope step. The instance conforms iff the scope, read as one sequence, is exactly one
% legal run of the method's steps (choose picks a branch, optional may be skipped, any_order accepts every order, if tests the state,
% until tests before each pass and fails at its cap, pick binds by a state atom). achieve and sub-task steps are not checked.

gl_check_methods(Steps, States, InF, Engaged, Deviations) :-
    findall(Id, rt_method(Id, _, _, _, _, _, _, _, _), Ids0), gl_dedup(Ids0, Ids),
    findall(X, ( member(step(_, Args, _, _), Steps), member(X, Args) ), Dom0), gl_dedup(Dom0, Dom),
    foldl(gl_method_instances(Steps, States, InF, Dom), Ids, e([], []), e(E0, D0)),
    reverse(E0, Engaged), reverse(D0, Deviations).

gl_method_instances(Steps, States, InF, Dom, Id, e(E0, D0), e(E, D)) :-
    rt_method(Id, Ver, Bind, _, _, HP, HTerms, Guard, Body),
    term_variables(HTerms, AVars),
    gl_prims(Body, Prims),
    findall(Vals,
        ( member(prim(Act, PTerms), Prims), nth1(J, Steps, step(Act, SArgs, _, _)),
          gl_in(InF, Id, J), length(PTerms, L), length(SArgs, L),
          copy_term(PTerms-AVars, PT1-AV1), PT1 = SArgs,
          gl_option_vectors(AV1, Dom, Vals) ),
        ValsL0),
    gl_dedup(ValsL0, ValsL),
    foldl(gl_instance(Id, Ver, Bind, HP, HTerms, Guard, Body, AVars, Steps, States, InF), ValsL, e(E0, D0), e(E, D)).

% each variable keeps the value the step bound, or ranges over the domain when the step left it open
gl_option_vectors([], _, []).
gl_option_vectors([V|Vs], Dom, [X|Xs]) :- ( nonvar(V) -> X = V ; member(X, Dom) ), gl_option_vectors(Vs, Dom, Xs).

gl_prims([], []).
gl_prims([N|Ns], Out) :- gl_prims_node(N, P1), gl_prims(Ns, P2), append(P1, P2, Out).
gl_prims_node(prim(A, T), [prim(A, T)]) :- !.
gl_prims_node(optional(X), P) :- !, gl_prims_node(X, P).
gl_prims_node(choose(Bs), P) :- !, gl_prims(Bs, P).
gl_prims_node(any_order(Xs), P) :- !, gl_prims(Xs, P).
gl_prims_node(if(_, T, E), P) :- !, gl_prims(T, P1), gl_prims(E, P2), append(P1, P2, P).
gl_prims_node(until(_, _, B), P) :- !, gl_prims(B, P).
gl_prims_node(_, []).

gl_instance(Id, Ver, Bind, _HP, HTerms, Guard, Body, AVars, Steps, States, InF, Vals, e(E0, D0), e(E, D)) :-
    findall(J, ( nth1(J, Steps, step(_, Args, _, _)), gl_in(InF, Id, J), ( AVars == [] -> true ; member(X, Args), memberchk(X, Vals) ) ), S0),
    sort(S0, S),
    (   S == [] -> E = E0, D = D0
    ;   copy_term(AVars-HTerms-Guard-Body, AV1-_-Guard1-Body1), AV1 = Vals,
        S = [First|_], F0 is First - 1, nth0(F0, States, SBefore),
        (   gl_holds(SBefore, Guard1)
        ->  ( gl_bad_forms(Body1) -> throw(error(method_forms_not_checked(Id), _)) ; true ),
            gl_scope(S, Steps, States, Scope),
            atomic_list_concat([Id|Vals], ' ', Inst),
            E = [engaged(Id, Ver, Bind, Inst)|E0],
            (   once(gl_rec(Body1, Scope, SBefore, [], _)) -> D = D0 ; D = [dev(Id, Ver, Bind, Inst)|D0] )
        ;   E = E0, D = D0
        )
    ).

gl_bad_forms(Nodes) :- member(N, Nodes), gl_bad_node(N), !.
gl_bad_node(task(_, _)).
gl_bad_node(achieve(_)).
gl_bad_node(optional(X)) :- gl_bad_node(X).
gl_bad_node(choose(Bs)) :- gl_bad_forms(Bs).
gl_bad_node(any_order(Xs)) :- gl_bad_forms(Xs).
gl_bad_node(if(_, T, E)) :- ( gl_bad_forms(T) ; gl_bad_forms(E) ).
gl_bad_node(until(_, _, B)) :- gl_bad_forms(B).

gl_scope([], _, _, []).
gl_scope([J|Js], Steps, States, [sc(A, Args, After)|T]) :-
    nth1(J, Steps, step(A, Args, _, _)), nth0(J, States, After), gl_scope(Js, Steps, States, T).

gl_rec([], Sc, Cur, Sc, Cur).
gl_rec([N|Ns], Sc0, Cur0, Sc, Cur) :- gl_rec1(N, Sc0, Cur0, Sc1, Cur1), gl_rec(Ns, Sc1, Cur1, Sc, Cur).

gl_rec1(prim(A, Terms), [sc(A, Args, After)|Rest], _, Rest, After) :- length(Terms, L), length(Args, L), Terms = Args.
gl_rec1(optional(X), Sc0, Cur0, Sc, Cur) :- ( gl_rec1(X, Sc0, Cur0, Sc, Cur) ; Sc = Sc0, Cur = Cur0 ).
gl_rec1(choose(Bs), Sc0, Cur0, Sc, Cur) :- member(B, Bs), gl_rec1(B, Sc0, Cur0, Sc, Cur).
gl_rec1(any_order(Xs), Sc0, Cur0, Sc, Cur) :- permutation(Xs, Ps), gl_rec(Ps, Sc0, Cur0, Sc, Cur).
gl_rec1(if(Alts, T, E), Sc0, Cur0, Sc, Cur) :-
    (   gl_first(Cur0, Alts) -> gl_rec(T, Sc0, Cur0, Sc, Cur) ; gl_rec(E, Sc0, Cur0, Sc, Cur) ).
gl_rec1(until(Alts, Max, Body), Sc0, Cur0, Sc, Cur) :- gl_rec_until(Alts, Max, 0, Body, Sc0, Cur0, Sc, Cur).
gl_rec1(pick(Leaf), Sc, Cur, Sc, Cur) :- findall(Leaf, gl_leaves_in(Cur, [Leaf]), Ls), member(Leaf, Ls).

gl_rec_until(Alts, Max, N, Body, Sc0, Cur0, Sc, Cur) :-
    (   gl_first(Cur0, Alts) -> Sc = Sc0, Cur = Cur0
    ;   N < Max, N1 is N + 1, gl_rec(Body, Sc0, Cur0, Sc1, Cur1), gl_rec_until(Alts, Max, N1, Body, Sc1, Cur1, Sc, Cur)
    ).

% ------------------------------------------------------------------------------------------------ the tasks and their JSON

gl_step_json(step(A, Args, Ver, Cost), _{action: A, args: AJ, version: Ver, cost: Cost}) :- rt_vals(Args, AJ).
gl_viol_json(v(Id, Ver, Sev, Bind, Cost, Values, Step, Why, Msg), _{id: Id, version: Ver, severity: Sev, binding: Bind, cost: Cost, values: VJ, step: Step, why: WJ, message: MJ}) :-
    rt_vals(Values, VJ), atom_string(Why, WJ), ( Msg == null -> MJ = null ; atom_string(Msg, MJ) ).
gl_eval_json(res(Vs, Trig, Used, Unsc), _{violations: VsJ, triggered: TJ, used: Used, unscoped: Unsc}) :-
    maplist(gl_viol_json, Vs, VsJ),
    findall(_{id: Id, values: VJ, severity: Sev}, ( member(t(Id, Values, Sev), Trig), rt_vals(Values, VJ) ), TJ).
gl_run_json(run(Decs, Steps, _, Cost, Eval), _{decisions: DJ, choices: CJ, steps: SJ, cost: Cost, eval: EJ}) :-
    findall(_{id: Id, version: V}, member(d(Id, V), Decs), DJ),
    findall(_{kind: K, step: N, chosen: ChJ, alternatives: AJ}, ( member(ch(K, N, Ch, Alts), Decs), gl_name_json(Ch, ChJ), maplist(gl_name_json, Alts, AJ) ), CJ),
    maplist(gl_step_json, Steps, SJ), gl_eval_json(Eval, EJ).

gl_name_json(prim(A, Args), _{action: A, args: AJ}) :- !, rt_vals(Args, AJ).
gl_name_json(X, J) :- atom_string(X, J).

% plan: the runs of every candidate method
gl_plan_task(P, Args, Max, D) :-
    gl_candidates(P, Args, Cands),
    findall(_{method: Id, runs: RJ, capped: CJ, nodes: Nodes, fails: FJ},
        ( member(Id, Cands),
          gl_runs(Id, P, Args, Max, Runs, Capped, Nodes),
          maplist(gl_run_json, Runs, RJ),
          findall(_{depth: Dp, action: A, args: AJ, mode: M, p: Pp, pargs: PJ}, ( gl_fail(Dp, A, As, M, Pp, PA), rt_vals(As, AJ), rt_vals(PA, PJ) ), FJ),
          ( Capped = capped(Kind, N) -> CJ = _{kind: Kind, max: N} ; CJ = null ) ),
        Per),
    D = _{candidates: Cands, per_method: Per}.

% conform: replay the trace (a record: effects are applied whatever the preconditions), judge the norms, check the methods
gl_conform_task(TraceSteps, Days, InF, D) :-
    rt_init(S0),
    gl_replay(TraceSteps, 1, S0, [S0], StatesRev, [], StepsRev, [], InfRev),
    reverse(StatesRev, States), reverse(StepsRev, Steps), reverse(InfRev, Inf),
    gl_goal_consts(GC),
    gl_eval(Steps, States, GC, true, Days, InF, Eval),
    gl_check_methods(Steps, States, InF, Engaged, Devs),
    gl_eval_json(Eval, EJ),
    maplist(gl_step_json, Steps, SJ),
    findall(_{id: Id, version: V, binding: B, instance: I}, member(engaged(Id, V, B, I), Engaged), EnJ),
    findall(_{id: Id, version: V, binding: B, instance: I}, member(dev(Id, V, B, I), Devs), DvJ),
    findall(_{step: J, action: A, requirement: R}, member(inf(J, A, R), Inf), InfJ),
    last(States, Fin),
    ( rt_goal(Alts) -> ( gl_holds(Fin, Alts) -> GoalOk = true ; GoalOk = false ) ; GoalOk = true ),
    D = _{steps: SJ, eval: EJ, engaged: EnJ, deviations: DvJ, infeasible: InfJ, goal_ok: GoalOk}.

gl_replay([], _, _, Sts, Sts, St, St, Inf, Inf).
gl_replay([t(A, Args)|T], K, S, Sts0, Sts, St0, St, Inf0, Inf) :-
    (   rt_action(A, _, _, Params0, _, _, _), length(Params0, L), length(Args, L) -> true
    ;   throw(error(unknown_action(A), _)) ),
    rt_action(A, Ver, Cost, Params, Leaves, Adds, Rems), Params = Args,
    findall(Adds-Rems, gl_leaves_in(S, Leaves), Sols),
    (   Sols = [Adds-Rems|_] -> Inf1 = Inf0
    ;   gl_unmet_text(S, Leaves, Req), Inf1 = [inf(K, A, Req)|Inf0] ),
    (   ground(Adds-Rems) -> gl_effect(S, Adds, Rems, S1) ; S1 = S ),
    K1 is K + 1,
    gl_replay(T, K1, S1, [S1|Sts0], Sts, [step(A, Args, Ver, Cost)|St0], St, Inf1, Inf).

gl_unmet_text(S, Leaves, Req) :-
    gl_load(S),
    (   member(l(Mode, P, A), Leaves), ground(A), \+ gl_leaf_ok(Mode, P, A)
    ->  ( Mode == pos -> format(atom(Req), '~w ~w', [P, A]) ; format(atom(Req), '~w ~w ~w', [Mode, P, A]) )
    ;   Req = unknown ).
gl_leaf_ok(pos, P, A) :- rt_call(pos, P, A), !.
gl_leaf_ok(not, P, A) :- rt_call(neg, P, A), !.
gl_leaf_ok(absent, P, A) :- \+ rt_call(pos, P, A).

% the norms that SHAPED a run: every norm matched by a step the engine could have taken at some state of the run (a prohibition that ruled
% the cheaper alternative out), judged as if that step had been taken
gl_trial_task(TSteps, GC, D) :-
    rt_init(S0),
    gl_trace_states(TSteps, S0, [S0], StatesRev, [], StepsRev),
    reverse(StatesRev, States), reverse(StepsRev, Steps),
    length(Steps, N),
    findall(Id,
        ( between(0, N, I), I < N,
          nth0(I, States, S),
          gl_applicable(S, A, Args, Ver, Cost, S1),
          I1 is I + 1,
          length(PreSteps, I), append(PreSteps, _, Steps),
          length(PreStates, I1), append(PreStates, _, States),
          append(PreSteps, [step(A, Args, Ver, Cost)], TrialSteps),
          append(PreStates, [S1], TrialStates),
          gl_eval(TrialSteps, TrialStates, GC, false, null, all, res(_, _, Used, _)),
          member(Id, Used) ),
        Ids0),
    sort(Ids0, Ids),
    D = _{used: Ids}.

gl_applicable(S, A, Args, Ver, Cost, S1) :-
    rt_action(A, Ver, Cost, Params, Leaves, Adds, Rems),
    findall(Params-Adds-Rems, gl_leaves_in(S, Leaves), Sols),
    member(Params-Adds-Rems, Sols), ground(Params), Args = Params,
    gl_effect(S, Adds, Rems, S1).

gl_trace_states([], _, Sts, Sts, St, St).
gl_trace_states([t(A, Args)|T], S, Sts0, Sts, St0, St) :-
    rt_action(A, Ver, Cost, Params, Leaves, Adds, Rems), Params = Args,
    findall(Adds-Rems, gl_leaves_in(S, Leaves), [Adds-Rems|_]),
    gl_effect(S, Adds, Rems, S1),
    gl_trace_states(T, S1, [S1|Sts0], Sts, [step(A, Args, Ver, Cost)|St0], St).

% the entry of a task: run it under the inference budget and print the result as JSON
gl_run(Infer, Task) :-
    catch(( call_with_inference_limit(Task, Infer, R0) -> ( R0 == inference_limit_exceeded -> Out = probes ; Out = done ) ; Out = failed ),
          Err, ( Out = error(Err) )),
    (   Out = error(E) -> gl_error_json(E, Json), json_write_dict(current_output, Json, [width(0)]), nl
    ;   Out == done -> true
    ;   json_write_dict(current_output, _{status: Out}, [width(0)]), nl ).

gl_error_json(error(Formal, _), _{status: error, error: S}) :- !, term_string(S, Formal).
gl_error_json(E, _{status: error, error: S}) :- term_string(S, E).

gl_emit(D) :- json_write_dict(current_output, _{status: done, result: D}, [width(0)]), nl.
