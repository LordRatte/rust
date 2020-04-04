const fs = require('fs');
const path = require('path');

function getNextStep(content, pos, stop) {
    while (pos < content.length && content[pos] !== stop &&
           (content[pos] === ' ' || content[pos] === '\t' || content[pos] === '\n')) {
        pos += 1;
    }
    if (pos >= content.length) {
        return null;
    }
    if (content[pos] !== stop) {
        return pos * -1;
    }
    return pos;
}

// Stupid function extractor based on indent. Doesn't support block
// comments. If someone puts a ' or an " in a block comment this
// will blow up. Template strings are not tested and might also be
// broken.
function extractFunction(content, functionName) {
    var indent = 0;
    var splitter = "function " + functionName + "(";

    while (true) {
        var start = content.indexOf(splitter);
        if (start === -1) {
            break;
        }
        var pos = start;
        while (pos < content.length && content[pos] !== ')') {
            pos += 1;
        }
        if (pos >= content.length) {
            break;
        }
        pos = getNextStep(content, pos + 1, '{');
        if (pos === null) {
            break;
        } else if (pos < 0) {
            content = content.slice(-pos);
            continue;
        }
        while (pos < content.length) {
            // Eat single-line comments
            if (content[pos] === '/' && pos > 0 && content[pos-1] === '/') {
                do {
                    pos += 1;
                } while (pos < content.length && content[pos] !== '\n');

            // Eat quoted strings
            } else if (content[pos] === '"' || content[pos] === "'" || content[pos] === "`") {
                var stop = content[pos];
                var is_escaped = false;
                do {
                    if (content[pos] === '\\') {
                        pos += 2;
                    } else {
                        pos += 1;
                    }
                } while (pos < content.length &&
                         (content[pos] !== stop || content[pos - 1] === '\\'));

            // Otherwise, check for indent
            } else if (content[pos] === '{') {
                indent += 1;
            } else if (content[pos] === '}') {
                indent -= 1;
                if (indent === 0) {
                    return content.slice(start, pos + 1);
                }
            }
            pos += 1;
        }
        content = content.slice(start + 1);
    }
    return null;
}

// Stupid function extractor for array.
function extractArrayVariable(content, arrayName) {
    var splitter = "var " + arrayName;
    while (true) {
        var start = content.indexOf(splitter);
        if (start === -1) {
            break;
        }
        var pos = getNextStep(content, start, '=');
        if (pos === null) {
            break;
        } else if (pos < 0) {
            content = content.slice(-pos);
            continue;
        }
        pos = getNextStep(content, pos, '[');
        if (pos === null) {
            break;
        } else if (pos < 0) {
            content = content.slice(-pos);
            continue;
        }
        while (pos < content.length) {
            if (content[pos] === '"' || content[pos] === "'") {
                var stop = content[pos];
                do {
                    if (content[pos] === '\\') {
                        pos += 2;
                    } else {
                        pos += 1;
                    }
                } while (pos < content.length &&
                         (content[pos] !== stop || content[pos - 1] === '\\'));
            } else if (content[pos] === ']' &&
                       pos + 1 < content.length &&
                       content[pos + 1] === ';') {
                return content.slice(start, pos + 2);
            }
            pos += 1;
        }
        content = content.slice(start + 1);
    }
    return null;
}

// Stupid function extractor for variable.
function extractVariable(content, varName) {
    var splitter = "var " + varName;
    while (true) {
        var start = content.indexOf(splitter);
        if (start === -1) {
            break;
        }
        var pos = getNextStep(content, start, '=');
        if (pos === null) {
            break;
        } else if (pos < 0) {
            content = content.slice(-pos);
            continue;
        }
        while (pos < content.length) {
            if (content[pos] === '"' || content[pos] === "'") {
                var stop = content[pos];
                do {
                    if (content[pos] === '\\') {
                        pos += 2;
                    } else {
                        pos += 1;
                    }
                } while (pos < content.length &&
                         (content[pos] !== stop || content[pos - 1] === '\\'));
            } else if (content[pos] === ';' || content[pos] === ',') {
                return content.slice(start, pos + 1);
            }
            pos += 1;
        }
        content = content.slice(start + 1);
    }
    return null;
}

function loadContent(content) {
    var Module = module.constructor;
    var m = new Module();
    m._compile(content, "tmp.js");
    m.exports.ignore_order = content.indexOf("\n// ignore-order\n") !== -1 ||
        content.startsWith("// ignore-order\n");
    m.exports.exact_check = content.indexOf("\n// exact-check\n") !== -1 ||
        content.startsWith("// exact-check\n");
    m.exports.should_fail = content.indexOf("\n// should-fail\n") !== -1 ||
        content.startsWith("// should-fail\n");
    return m.exports;
}

function readFile(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function loadThings(thingsToLoad, kindOfLoad, funcToCall, fileContent) {
    var content = '';
    for (var i = 0; i < thingsToLoad.length; ++i) {
        var tmp = funcToCall(fileContent, thingsToLoad[i]);
        if (tmp === null) {
            console.error('unable to find ' + kindOfLoad + ' "' + thingsToLoad[i] + '"');
            process.exit(1);
        }
        content += tmp;
        content += 'exports.' + thingsToLoad[i] + ' = ' + thingsToLoad[i] + ';';
    }
    return content;
}

function lookForEntry(entry, data) {
    for (var i = 0; i < data.length; ++i) {
        var allGood = true;
        for (var key in entry) {
            if (!entry.hasOwnProperty(key)) {
                continue;
            }
            var value = data[i][key];
            // To make our life easier, if there is a "parent" type, we add it to the path.
            if (key === 'path' && data[i]['parent'] !== undefined) {
                if (value.length > 0) {
                    value += '::' + data[i]['parent']['name'];
                } else {
                    value = data[i]['parent']['name'];
                }
            }
            if (value !== entry[key]) {
                allGood = false;
                break;
            }
        }
        if (allGood === true) {
            return i;
        }
    }
    return null;
}

function loadMainJsAndIndex(mainJs, aliases, searchIndex, crate) {
    if (searchIndex[searchIndex.length - 1].length === 0) {
        searchIndex.pop();
    }
    searchIndex.pop();
    searchIndex = loadContent(searchIndex.join("\n") + '\nexports.searchIndex = searchIndex;');
    finalJS = "";

    var arraysToLoad = ["itemTypes"];
    var variablesToLoad = ["MAX_LEV_DISTANCE", "MAX_RESULTS", "NO_TYPE_FILTER",
                           "GENERICS_DATA", "NAME", "INPUTS_DATA", "OUTPUT_DATA",
                           "TY_PRIMITIVE", "TY_KEYWORD",
                           "levenshtein_row2"];
    // execQuery first parameter is built in getQuery (which takes in the search input).
    // execQuery last parameter is built in buildIndex.
    // buildIndex requires the hashmap from search-index.
    var functionsToLoad = ["buildHrefAndPath", "pathSplitter", "levenshtein", "validateResult",
                           "getQuery", "buildIndex", "execQuery", "execSearch"];

    finalJS += 'window = { "currentCrate": "' + crate + '" };\n';
    finalJS += 'var rootPath = "../";\n';
    finalJS += aliases;
    finalJS += loadThings(arraysToLoad, 'array', extractArrayVariable, mainJs);
    finalJS += loadThings(variablesToLoad, 'variable', extractVariable, mainJs);
    finalJS += loadThings(functionsToLoad, 'function', extractFunction, mainJs);

    var loaded = loadContent(finalJS);
    var index = loaded.buildIndex(searchIndex.searchIndex);

    return [loaded, index];
}

function runChecks(testFile, loaded, index) {
    var errors = 0;
    var loadedFile = loadContent(
        readFile(testFile) + 'exports.QUERY = QUERY;exports.EXPECTED = EXPECTED;');

    const expected = loadedFile.EXPECTED;
    const query = loadedFile.QUERY;
    const filter_crate = loadedFile.FILTER_CRATE;
    const ignore_order = loadedFile.ignore_order;
    const exact_check = loadedFile.exact_check;
    const should_fail = loadedFile.should_fail;

    var results = loaded.execSearch(loaded.getQuery(query), index);
    var error_text = [];

    for (var key in expected) {
        if (!expected.hasOwnProperty(key)) {
            continue;
        }
        if (!results.hasOwnProperty(key)) {
            error_text.push('==> Unknown key "' + key + '"');
            break;
        }
        var entry = expected[key];
        var prev_pos = -1;
        for (var i = 0; i < entry.length; ++i) {
            var entry_pos = lookForEntry(entry[i], results[key]);
            if (entry_pos === null) {
                error_text.push("==> Result not found in '" + key + "': '" +
                                JSON.stringify(entry[i]) + "'");
            } else if (exact_check === true && prev_pos + 1 !== entry_pos) {
                error_text.push("==> Exact check failed at position " + (prev_pos + 1) + ": " +
                                "expected '" + JSON.stringify(entry[i]) + "' but found '" +
                                JSON.stringify(results[key][i]) + "'");
            } else if (ignore_order === false && entry_pos < prev_pos) {
                error_text.push("==> '" + JSON.stringify(entry[i]) + "' was supposed to be " +
                                " before '" + JSON.stringify(results[key][entry_pos]) + "'");
            } else {
                prev_pos = entry_pos;
            }
        }
    }
    if (error_text.length === 0 && should_fail === true) {
        errors += 1;
        console.error("FAILED");
        console.error("==> Test was supposed to fail but all items were found...");
    } else if (error_text.length !== 0 && should_fail === false) {
        errors += 1;
        console.error("FAILED");
        console.error(error_text.join("\n"));
    } else {
        console.log("OK");
    }
    return errors;
}

function load_files(doc_folder, version, crate) {
    var mainJs = readFile(doc_folder + "/main" + version + ".js");
    var aliases = readFile(doc_folder + "/aliases" + version + ".js");
    var searchIndex = readFile(doc_folder + "/search-index" + version + ".js").split("\n");

    return loadMainJsAndIndex(mainJs, aliases, searchIndex, crate);
}

function showHelp() {
    console.log("rustdoc-js options:");
    console.log("  --doc-folder [PATH] : location of the generated doc folder");
    console.log("  --help              : show this message then quit");
    console.log("  --std               : to run std tests");
    console.log("  --test-file   [PATH]: location of the JS test file");
    console.log("  --test-folder [PATH]: location of the JS tests folder");
    console.log("  --version [STRING]  : version used when generating docs (used to get js files)");
}

function parseOptions(args) {
    var opts = {
        "is_std": false,
        "version": "",
        "doc_folder": "",
        "test_folder": "",
        "test_file": "",
    };
    var correspondances = {
        "--version": "version",
        "--doc-folder": "doc_folder",
        "--test-folder": "test_folder",
        "--test-file": "test_file",
    };

    for (var i = 0; i < args.length; ++i) {
        if (args[i] === "--version"
            || args[i] === "--doc-folder"
            || args[i] === "--test-folder"
            || args[i] === "--test-file") {
            i += 1;
            if (i >= args.length) {
                console.error("Missing argument after `" + args[i - 1] + "` option.");
                return null;
            }
            opts[correspondances[args[i - 1]]] = args[i];
        } else if (args[i] === "--std") {
            opts["is_std"] = true;
        } else if (args[i] === "--help") {
            showHelp();
            process.exit(0);
        } else {
            console.error("Unknown option `" + args[i] + "`.");
            console.error("Use `--help` to see the list of options");
            return null;
        }
    }
    if (opts["doc_folder"].length < 1) {
        console.error("Missing `--doc-folder` option.");
        return null;
    } else if (opts["test_folder"].length < 1 && opts["test_file"].length < 1) {
        console.error("At least one of `--test-folder` or `--test-file` option is required.");
        return null;
    } else if (opts["is_std"] === true && opts["test_file"].length !== 0) {
        console.error("`--std` and `--test-file` options can't be used at the same time.")
    }
    return opts;
}

function checkFile(test_file, opts, std_loaded, std_index) {
    const test_name = path.basename(test_file, ".js");

    process.stdout.write('Checking "' + test_name + '" ... ');

    var loaded = std_loaded;
    var index = std_index;
    if (opts["is_std"] !== true) {
        var tmp = load_files(path.join(opts["doc_folder"], test_name), opts["version"], test_name);
        loaded = tmp[0];
        index = tmp[1];
    }
    return runChecks(test_file, loaded, index);
}

function main(argv) {
    var opts = parseOptions(argv.slice(2));
    if (opts === null) {
        return 1;
    }

    var std_loaded = null;
    var std_index = null;
    if (opts["is_std"] === true) {
        var tmp = load_files(opts["doc_folder"], opts["version"], "std");
        std_loaded = tmp[0];
        std_index = tmp[1];
    }

    var errors = 0;

    if (opts["test_file"].length !== 0) {
        errors += checkFile(opts["test_file"], opts, null, null);
    }
    if (opts["test_folder"].length !== 0) {
        fs.readdirSync(opts["test_folder"]).forEach(function(file) {
            if (!file.endsWith(".js")) {
                return;
            }
            errors += checkFile(path.join(opts["test_folder"], file), opts, std_loaded, std_index);
        });
    }
    return errors > 0 ? 1 : 0;
}

process.exit(main(process.argv));
