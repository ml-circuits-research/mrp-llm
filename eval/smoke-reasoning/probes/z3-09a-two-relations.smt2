; expect: unsat unsat unsat
; Case 09a lowered to Z3 with two relations per predicate (p_pos and p_neg) and completion for NON-recursive predicates.
; check 1: flies tweety is entailed; check 2: flies pingu is not derivable; check 3: tweety cannot be both flies_pos and flies_neg.
(declare-datatypes ((E 0)) (((tweety) (pingu))))
(define-fun penguin_pos ((x E)) Bool (= x pingu))
(define-fun bird_pos ((x E)) Bool (or (= x tweety) (penguin_pos x)))
(define-fun applies ((x E)) Bool (bird_pos x))
(define-fun blocked ((x E)) Bool (and (applies x) (penguin_pos x)))
(define-fun flies_pos ((x E)) Bool (and (applies x) (not (blocked x))))
(define-fun flies_neg ((x E)) Bool false)
(push) (assert (not (flies_pos tweety))) (check-sat) (pop)
(push) (assert (flies_pos pingu)) (check-sat) (pop)
(push) (assert (and (flies_pos tweety) (flies_neg tweety))) (check-sat) (pop)
