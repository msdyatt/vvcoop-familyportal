#!/usr/bin/env python3
"""Registers Swift files in App.xcodeproj (the project lists files explicitly, objectVersion 60).

usage: python3 addfiles.py Frame/NativeScreenController.swift Messages/Foo.swift ...
A path's first folder is the group it joins under App/ (Frame exists; others are created). Safe to run again: files already
listed are skipped.
"""
import hashlib, re, sys

PROJECT = "App/App.xcodeproj/project.pbxproj"
APP_GROUP = "504EC3061FED79650016851F"

def ident(seed):
    return "F4A1" + hashlib.sha1(seed.encode()).hexdigest()[:20].upper()

text = open(PROJECT).read()
for rel in sys.argv[1:]:
    folder, name = rel.split("/")
    if re.search(r"path = %s;" % re.escape(name), text):
        continue
    ref, build = ident("ref:" + rel), ident("build:" + rel)
    group_id = ident("group:" + folder)
    text = text.replace("/* End PBXBuildFile section */", f"\t\t{build} /* {name} in Sources */ = {{isa = PBXBuildFile; fileRef = {ref} /* {name} */; }};\n/* End PBXBuildFile section */", 1)
    text = text.replace("/* End PBXFileReference section */", f"\t\t{ref} /* {name} */ = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = {name}; sourceTree = \"<group>\"; }};\n/* End PBXFileReference section */", 1)
    if f"path = {folder}; sourceTree" not in text:
        group = f"\t\t{group_id} /* {folder} */ = {{isa = PBXGroup; children = (\n\t\t\t); path = {folder}; sourceTree = \"<group>\"; }};\n"
        text = text.replace("/* End PBXGroup section */", group + "/* End PBXGroup section */", 1)
        text = text.replace(f"\t\t\t\tF4A11E000000000000000300 /* Frame */,\n", f"\t\t\t\tF4A11E000000000000000300 /* Frame */,\n\t\t\t\t{group_id} /* {folder} */,\n", 1)
    # add to the group's children
    m = re.search(r"(/\* %s \*/ = \{isa = PBXGroup; children = \()(.*?)(\); path = %s;)" % (re.escape(folder), re.escape(folder)), text, re.S)
    text = text[:m.end(1)] + f"\n\t\t\t\t{ref} /* {name} */," + text[m.end(1):]
    # add to the sources phase
    text = text.replace("\t\t\t\tF4A11E000000000000000206 /* FrameController.swift in Sources */,\n", f"\t\t\t\tF4A11E000000000000000206 /* FrameController.swift in Sources */,\n\t\t\t\t{build} /* {name} in Sources */,\n", 1)
open(PROJECT, "w").write(text)
