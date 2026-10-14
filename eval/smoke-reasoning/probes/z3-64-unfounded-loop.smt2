; expect: sat unsat
; Case 64: warm and hot support each other through a positive loop; the heater is the only external reason for warm. The Clark completion
; over the finite domain admits a model with warm(n2) and hot(n2) both true (each supported by the other), which is not the least model:
; check 1 is sat (the unfounded model exists), check 2 is unsat (warm(h1) is forced by the heater, as in every model).
; z3-smt-bounded therefore declares recursion unsupported and answers not_expressible for case 64.
(declare-datatypes ((E 0)) (((h1) (n2))))
(declare-fun warm (E) Bool)
(declare-fun hot (E) Bool)
(define-fun heater ((x E)) Bool (= x h1))
(assert (forall ((x E)) (= (warm x) (or (heater x) (hot x)))))
(assert (forall ((x E)) (= (hot x) (warm x))))
(push) (assert (warm n2)) (check-sat) (pop)
(push) (assert (not (warm h1))) (check-sat) (pop)
