; expect: sat
; Case 04b: a and b form a cycle, c is isolated. Clark completion of the recursive predicate reach over the finite domain still
; admits a model with reach(a,c) (a and b support each other around the cycle), although reach(a,c) is not derivable. Completion
; alone is therefore unsound for recursive predicates; z3-smt-bounded declares recursion unsupported.
(declare-datatypes ((E 0)) (((a) (b) (c))))
(declare-fun reach (E E) Bool)
(define-fun edge ((x E) (y E)) Bool (or (and (= x a) (= y b)) (and (= x b) (= y a))))
(assert (forall ((x E) (y E)) (= (reach x y) (or (edge x y) (exists ((m E)) (and (edge x m) (reach m y)))))))
(push) (assert (reach a c)) (check-sat) (pop)
