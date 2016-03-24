use rustc::lint::*;
use rustc_front::hir::*;
use rustc_front::intravisit::*;
use syntax::ast::LitKind;
use utils::{span_lint_and_then, in_macro, snippet_opt, SpanlessEq};

/// **What it does:** This lint checks for boolean expressions that can be written more concisely
///
/// **Why is this bad?** Readability of boolean expressions suffers from unnecesessary duplication
///
/// **Known problems:** Ignores short circuting behavior, bitwise and/or and xor. Ends up suggesting things like !(a == b)
///
/// **Example:** `if a && true` should be `if a`
declare_lint! {
    pub NONMINIMAL_BOOL, Allow,
    "checks for boolean expressions that can be written more concisely"
}

/// **What it does:** This lint checks for boolean expressions that contain terminals that can be eliminated
///
/// **Why is this bad?** This is most likely a logic bug
///
/// **Known problems:** Ignores short circuiting behavior
///
/// **Example:** The `b` in `if a && b || a` is unnecessary because the expression is equivalent to `if a`
declare_lint! {
    pub LOGIC_BUG, Warn,
    "checks for boolean expressions that contain terminals which can be eliminated"
}

#[derive(Copy,Clone)]
pub struct NonminimalBool;

impl LintPass for NonminimalBool {
    fn get_lints(&self) -> LintArray {
        lint_array!(NONMINIMAL_BOOL, LOGIC_BUG)
    }
}

impl LateLintPass for NonminimalBool {
    fn check_item(&mut self, cx: &LateContext, item: &Item) {
        NonminimalBoolVisitor(cx).visit_item(item)
    }
}

struct NonminimalBoolVisitor<'a, 'tcx: 'a>(&'a LateContext<'a, 'tcx>);

use quine_mc_cluskey::Bool;
struct Hir2Qmm<'a, 'tcx: 'a, 'v> {
    terminals: Vec<&'v Expr>,
    cx: &'a LateContext<'a, 'tcx>
}

impl<'a, 'tcx, 'v> Hir2Qmm<'a, 'tcx, 'v> {
    fn extract(&mut self, op: BinOp_, a: &[&'v Expr], mut v: Vec<Bool>) -> Result<Vec<Bool>, String> {
        for a in a {
            if let ExprBinary(binop, ref lhs, ref rhs) = a.node {
                if binop.node == op {
                    v = self.extract(op, &[lhs, rhs], v)?;
                    continue;
                }
            }
            v.push(self.run(a)?);
        }
        Ok(v)
    }

    fn run(&mut self, e: &'v Expr) -> Result<Bool, String> {
        // prevent folding of `cfg!` macros and the like
        if !in_macro(self.cx, e.span) {
            match e.node {
                ExprUnary(UnNot, ref inner) => return Ok(Bool::Not(box self.run(inner)?)),
                ExprBinary(binop, ref lhs, ref rhs) => {
                    match binop.node {
                        BiOr => return Ok(Bool::Or(self.extract(BiOr, &[lhs, rhs], Vec::new())?)),
                        BiAnd => return Ok(Bool::And(self.extract(BiAnd, &[lhs, rhs], Vec::new())?)),
                        _ => {},
                    }
                },
                ExprLit(ref lit) => {
                    match lit.node {
                        LitKind::Bool(true) => return Ok(Bool::True),
                        LitKind::Bool(false) => return Ok(Bool::False),
                        _ => {},
                    }
                },
                _ => {},
            }
        }
        if let Some((n, _)) = self.terminals
                                  .iter()
                                  .enumerate()
                                  .find(|&(_, expr)| SpanlessEq::new(self.cx).ignore_fn().eq_expr(e, expr)) {
            #[allow(cast_possible_truncation)]
            return Ok(Bool::Term(n as u8));
        }
        let n = self.terminals.len();
        self.terminals.push(e);
        if n < 32 {
            #[allow(cast_possible_truncation)]
            Ok(Bool::Term(n as u8))
        } else {
            Err("too many literals".to_owned())
        }
    }
}

fn suggest(cx: &LateContext, suggestion: &Bool, terminals: &[&Expr]) -> String {
    fn recurse(brackets: bool, cx: &LateContext, suggestion: &Bool, terminals: &[&Expr], mut s: String) -> String {
        use quine_mc_cluskey::Bool::*;
        match *suggestion {
            True => {
                s.extend("true".chars());
                s
            },
            False => {
                s.extend("false".chars());
                s
            },
            Not(ref inner) => {
                s.push('!');
                recurse(true, cx, inner, terminals, s)
            },
            And(ref v) => {
                if brackets {
                    s.push('(');
                }
                s = recurse(true, cx, &v[0], terminals, s);
                for inner in &v[1..] {
                    s.extend(" && ".chars());
                    s = recurse(true, cx, inner, terminals, s);
                }
                if brackets {
                    s.push(')');
                }
                s
            },
            Or(ref v) => {
                if brackets {
                    s.push('(');
                }
                s = recurse(true, cx, &v[0], terminals, s);
                for inner in &v[1..] {
                    s.extend(" || ".chars());
                    s = recurse(true, cx, inner, terminals, s);
                }
                if brackets {
                    s.push(')');
                }
                s
            },
            Term(n) => {
                s.extend(snippet_opt(cx, terminals[n as usize].span).expect("don't try to improve booleans created by macros").chars());
                s
            }
        }
    }
    recurse(false, cx, suggestion, terminals, String::new())
}

fn simple_negate(b: Bool) -> Bool {
    use quine_mc_cluskey::Bool::*;
    match b {
        True => False,
        False => True,
        t @ Term(_) => Not(Box::new(t)),
        And(mut v) => {
            for el in &mut v {
                *el = simple_negate(::std::mem::replace(el, True));
            }
            Or(v)
        },
        Or(mut v) => {
            for el in &mut v {
                *el = simple_negate(::std::mem::replace(el, True));
            }
            And(v)
        },
        Not(inner) => *inner,
    }
}

fn terminal_stats(b: &Bool) -> [usize; 32] {
    fn recurse(b: &Bool, stats: &mut [usize; 32]) {
        match *b {
            True | False => {},
            Not(ref inner) => recurse(inner, stats),
            And(ref v) | Or(ref v) => for inner in v {
                recurse(inner, stats)
            },
            Term(n) => stats[n as usize] += 1,
        }
    }
    use quine_mc_cluskey::Bool::*;
    let mut stats = [0; 32];
    recurse(b, &mut stats);
    stats
}

impl<'a, 'tcx> NonminimalBoolVisitor<'a, 'tcx> {
    fn bool_expr(&self, e: &Expr) {
        let mut h2q = Hir2Qmm {
            terminals: Vec::new(),
            cx: self.0,
        };
        if let Ok(expr) = h2q.run(e) {
            let stats = terminal_stats(&expr);
            let mut simplified = expr.simplify();
            for simple in Bool::Not(Box::new(expr.clone())).simplify() {
                match simple {
                    Bool::Not(_) | Bool::True | Bool::False => {},
                    _ => simplified.push(Bool::Not(Box::new(simple.clone()))),
                }
                let simple_negated = simple_negate(simple);
                if simplified.iter().any(|s| *s == simple_negated) {
                    continue;
                }
                simplified.push(simple_negated);
            }
            if !simplified.iter().any(|s| *s == expr) {
                let mut improvements = Vec::new();
                'simplified: for suggestion in &simplified {
                    let simplified_stats = terminal_stats(&suggestion);
                    let mut improvement = false;
                    for i in 0..32 {
                        // ignore any "simplifications" that end up requiring a terminal more often than in the original expression
                        if stats[i] < simplified_stats[i] {
                            continue 'simplified;
                        }
                        // if the number of occurrences of a terminal doesn't increase, this expression is a candidate for improvement
                        improvement = true;
                        if stats[i] != 0 && simplified_stats[i] == 0 {
                            span_lint_and_then(self.0, LOGIC_BUG, e.span, "this boolean expression contains a logic bug", |db| {
                                db.span_help(h2q.terminals[i].span, "this expression can be optimized out by applying boolean operations to the outer expression");
                                db.span_suggestion(e.span, "it would look like the following", suggest(self.0, suggestion, &h2q.terminals));
                            });
                            // don't also lint `NONMINIMAL_BOOL`
                            improvements.clear();
                            break 'simplified;
                        }
                    }
                    if improvement {
                        improvements.push(suggestion);
                    }
                }
                if !improvements.is_empty() {
                    span_lint_and_then(self.0, NONMINIMAL_BOOL, e.span, "this boolean expression can be simplified", |db| {
                        for suggestion in &improvements {
                            db.span_suggestion(e.span, "try", suggest(self.0, suggestion, &h2q.terminals));
                        }
                    });
                }
            }
        }
    }
}

impl<'a, 'v, 'tcx> Visitor<'v> for NonminimalBoolVisitor<'a, 'tcx> {
    fn visit_expr(&mut self, e: &'v Expr) {
        if in_macro(self.0, e.span) { return }
        match e.node {
            ExprBinary(binop, _, _) if binop.node == BiOr || binop.node == BiAnd => self.bool_expr(e),
            ExprUnary(UnNot, ref inner) => {
                if self.0.tcx.node_types()[&inner.id].is_bool() {
                    self.bool_expr(e);
                } else {
                    walk_expr(self, e);
                }
            },
            _ => walk_expr(self, e),
        }
    }
}
