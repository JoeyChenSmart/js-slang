import * as sym from './symbolic'
import * as create from '../utils/astCreator'
import * as st from './state'
import * as es from 'estree'
import * as stdList from '../stdlib/list'
import { checkForInfiniteLoop, InfiniteLoopError } from './detect'
import { instrument, InfiniteLoopRuntimeFunctions as functionNames } from './instrument'
import { parse } from '../parser/parser'
import { createContext } from '../index'

function checkTimeout(state: st.State) {
  if (state.hasTimedOut()) {
    throw new Error('timeout')
  }
}

/**
 * This function is run whenever a variable is being accessed.
 * If a variable has been added to state.variablesToReset, it will
 * be lazily 'reset' (concretized and re-hybridized) here.
 */
function hybridize(originalValue: any, name: string, state: st.State) {
  if (typeof originalValue === 'function') {
    return originalValue
  }
  let value = originalValue
  if (state.variablesToReset.has(name)) {
    value = sym.deepConcretizeInplace(value)
  }
  return sym.hybridizeNamed(name, value)
}

function saveVarIfHybrid(value: any, name: string, state: st.State) {
  state.variablesToReset.delete(name)
  if (sym.isHybrid(value)) {
    state.variablesModified.set(name, value)
  }
  return value
}

/**
 * Saves the boolean value if it is a hybrid, else set the
 * path to invalid.
 * Does not save in the path if the value is a boolean literal to
 * reduce noise.
 */
function saveBoolIfHybrid(value: any, state: st.State) {
  if (sym.isHybrid(value) && value.type === 'value') {
    if (value.invalid) {
      state.setInvalidPath()
      return sym.shallowConcretize(value)
    }
    if (value.symbolic.type !== 'Literal') {
      let theExpr: es.Expression = value.symbolic
      if (!value.concrete) {
        theExpr = value.negation ? value.negation : create.unaryExpression('!', theExpr)
      }
      state.savePath(theExpr)
    }
    return sym.shallowConcretize(value)
  } else {
    state.setInvalidPath()
    return value
  }
}

function wrapArgIfFunction(arg: any, state: st.State) {
  if (typeof arg === 'function') {
    return (...args: any) => {
      state.functionWasPassedAsArgument = true
      return arg(...args)
    }
  }
  return arg
}

function preFunction(name: string, args: [string, any][], state: st.State) {
  checkTimeout(state)
  // track functions which were passed as arguments in a different tracker
  const newName = state.functionWasPassedAsArgument ? '*' + name : name
  const [tracker, firstIteration] = state.enterFunction(newName)
  if (!firstIteration) {
    state.cleanUpVariables()
    state.saveArgsInTransition(args, tracker)
    if (!state.functionWasPassedAsArgument) {
      const previousIterations = tracker.slice(0, tracker.length - 1)
      dispatchIfMeetsThreshold(previousIterations, state, name)
    }
  }
  tracker.push(state.newStackFrame())

  // do not consider these functions for dispatch.
  state.functionWasPassedAsArgument = false
}

function returnFunction(value: any, state: st.State) {
  state.cleanUpVariables()
  if (!state.streamMode) state.returnLastFunction()
  return value
}

function enterLoop(state: st.State) {
  state.loopStack.unshift([state.newStackFrame()])
}

// ignoreMe: hack to squeeze this inside the 'update' of for statements
function postLoop(state: st.State, ignoreMe?: any) {
  checkTimeout(state)
  const previousIterations = state.loopStack[0]
  dispatchIfMeetsThreshold(previousIterations.slice(0, previousIterations.length - 1), state)
  state.cleanUpVariables()
  previousIterations.push(state.newStackFrame())
  return ignoreMe
}

function exitLoop(state: st.State) {
  state.cleanUpVariables()
  state.exitLoop()
}

function dispatchIfMeetsThreshold(
  stackPositions: number[],
  state: st.State,
  functionName?: string
) {
  let checkpoint = state.threshold
  while (checkpoint <= stackPositions.length) {
    if (stackPositions.length === checkpoint) {
      checkForInfiniteLoop(stackPositions, state, functionName)
    }
    checkpoint = checkpoint * 2
  }
}

/**
 * Test if stream is infinite. May destructively change the program
 * environment. If it is not infinite, throw a timeout error.
 */
function testIfInfiniteStream(stream: any, state: st.State) {
  let next = stream
  for (let i = 0; i <= state.threshold; i++) {
    if (stdList.is_null(next)) {
      break
    } else {
      const nextTail = stdList.is_pair(next) ? next[1] : undefined
      if (typeof nextTail === 'function') {
        next = sym.shallowConcretize(nextTail())
      } else {
        break
      }
    }
  }
  throw new Error('timeout')
}

const builtinSpecialCases = {
  is_null(maybeHybrid: any, state?: st.State) {
    const xs = sym.shallowConcretize(maybeHybrid)
    const conc = stdList.is_null(xs)
    const theTail = stdList.is_pair(xs) ? xs[1] : undefined
    const isStream = typeof theTail === 'function'
    if (state && isStream) {
      const lastFunction = state.getLastFunctionName()
      if (state.streamMode === true && state.streamLastFunction === lastFunction) {
        // heuristic to make sure we are at the same is_null call
        testIfInfiniteStream(sym.shallowConcretize(theTail()), state)
      } else {
        let count = state.streamCounts.get(lastFunction)
        if (count === undefined) {
          count = 1
        }
        if (count > state.streamThreshold) {
          state.streamMode = true
          state.streamLastFunction = lastFunction
        }
        state.streamCounts.set(lastFunction, count + 1)
      }
    } else {
      return conc
    }
    return
  },
  display: nothingFunction,
  display_list: nothingFunction
}

function prepareBuiltins(oldBuiltins: Map<string, any>) {
  const newBuiltins = new Map<string, any>()
  for (const [name, fun] of oldBuiltins) {
    const specialCase = builtinSpecialCases[name]
    if (specialCase !== undefined) {
      newBuiltins.set(name, specialCase)
    } else {
      newBuiltins.set(name, (...args: any[]) => fun(...args.map(sym.shallowConcretize)))
    }
  }
  newBuiltins.set('undefined', undefined)
  return newBuiltins
}

function nothingFunction(...args: any[]) {
  return nothingFunction
}

function trackLoc(loc: es.SourceLocation | undefined, state: st.State, ignoreMe?: () => any) {
  state.lastLocation = loc
  if (ignoreMe !== undefined) {
    return ignoreMe()
  }
}

const functions = {}
functions[functionNames.nothingFunction] = nothingFunction
functions[functionNames.concretize] = sym.shallowConcretize
functions[functionNames.hybridize] = hybridize
functions[functionNames.wrapArg] = wrapArgIfFunction
functions[functionNames.dummify] = sym.makeDummyHybrid
functions[functionNames.saveBool] = saveBoolIfHybrid
functions[functionNames.saveVar] = saveVarIfHybrid
functions[functionNames.preFunction] = preFunction
functions[functionNames.returnFunction] = returnFunction
functions[functionNames.postLoop] = postLoop
functions[functionNames.enterLoop] = enterLoop
functions[functionNames.exitLoop] = exitLoop
functions[functionNames.trackLoc] = trackLoc
functions[functionNames.evalB] = sym.evaluateHybridBinary
functions[functionNames.evalU] = sym.evaluateHybridUnary

export function testForInfiniteLoop(code: string, previousCodeStack: string[]) {
  const context = createContext(4, 'default', undefined, undefined)
  const prelude = parse(context.prelude as string, context) as es.Program
  const previous: es.Program[] = []
  context.prelude = null
  for (const code of previousCodeStack) {
    const ast = parse(code, context)
    if (ast !== undefined) previous.push(ast)
  }
  previous.push(prelude)
  const program = parse(code, context)
  if (program === undefined) return
  const newBuiltins = prepareBuiltins(context.nativeStorage.builtins)
  const [instrumentedCode, functionsId, stateId, builtinsId] = instrument(
    previous,
    program,
    newBuiltins.keys()
  )

  const state = new st.State()

  const sandboxedRun = new Function('code', functionsId, stateId, builtinsId, 'return eval(code)')

  try {
    sandboxedRun(instrumentedCode, functions, state, newBuiltins)
  } catch (error) {
    if (error instanceof InfiniteLoopError) {
      if (state.lastLocation !== undefined) {
        error.location = state.lastLocation
      }
      return error
    }
  }
  return undefined
}