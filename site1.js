const yaml         = require("js-yaml");
const mkdirp       = require("mkdirp");
const fs           = require("fs");
const _            = require("underscore");
const mv           = require("mv");
const moment       = require("moment");
const colors       = require("colors/safe");
const childProcess = require("child_process");
const Promise      = require("bluebird");

class Site {
    constructor(siteName, tui) {
        this.siteName   = siteName;
        this.padName    = siteName.padEnd(9, " ");
        this.listName   = siteName.toLowerCase();
        this.cfgname    = tui.configdir + this.listName + ".yml";
        this.updatename = tui.configdir + this.listName + "_updates.yml";

        // sitename.yml
        this.siteConfig = yaml.safeLoad(fs.readFileSync(this.cfgname, "utf8"));

        // Directory suffix
        this.siteDir = "_" + this.listName;

        // Blessed UI elements
        this.tui = tui;

        // Streamers that are being temporarily captured for this session only
        this.tempList = [];

        // Contains JSON indexed by UID:
        //     uid
        //     nm
        //     state
        //     filename
        //     captureProcess
        //     postProcess
        this.streamerList = new Map();

        tui.addSite(this);

        this.msg(this.siteConfig.streamers.length + " streamer(s) in config");
    }

    getDateTime() {
        return moment().format(this.tui.config.dateFormat);
    }

    getStreamerList() {
        return Array.from(this.streamerList.values());
    }

    getFileName(nm) {
        let filename = nm + "_";

        if (this.tui.config.includeSiteInFile) {
            filename += this.listName + "_";
        }
        filename += this.getDateTime();
        return filename;
    }

    checkFileSize() {
        const maxByteSize = this.tui.config.maxByteSize;
        if (maxByteSize === 0) {
            return;
        }

        for (const streamers of this.streamerList.values()) {
            if (streamers.captureProcess === null) {
                continue;
            }

            const stat = fs.statSync(this.tui.config.captureDirectory + "/" + streamers.filename);
            this.dbgMsg(colors.name(streamers.nm) + " file size (" + streamers.filename + "), size=" + stat.size + ", maxByteSize=" + maxByteSize);
            if (stat.size >= maxByteSize) {
                this.msg(colors.name(streamers.nm) + " recording has exceeded file size limit (size=" + stat.size + " > maxByteSize=" + maxByteSize + ")");
                streamers.captureProcess.kill("SIGINT");
            }
        }
    }

    disconnect() {
        // optional virtual method
    }

    getCaptureArguments(url, filename) {
        let params = [];

        if (this.tui.config.streamlink) {
            params = [
                "-o",
                this.tui.config.captureDirectory + "/" + filename + ".ts",
                url,
                "best"
            ];
            if (!this.noHLS) {
                params.push("--hlssession-time");
                params.push("00:05:00");
                params.push("--hlssession-segment");
            }
            if (this.tui.config.debugrecorder) {
                params.push("-l");
                params.push("debug");
            } else {
                params.push("-Q");
            }
        } else {
            params = [
                "-hide_banner",
                "-i",
                url,
                "-c",
                "copy",
                "-vsync",
                "2",
                "-r",
                "60",
                "-b:v",
                "500k",
                this.tui.config.captureDirectory + "/" + filename + ".ts"
            ];
            if (!this.tui.config.debugrecorder) {
                params.push("-v");
                params.push("fatal");
            }
        }
        return params;
    }

    processUpdates() {
        const stats = fs.statSync(this.updatename);
        if (!stats.isFile()) {
            this.dbgMsg(this.updatename + " does not exist");
            return Promise.resolve({includeStreamers: [], excludeStreamers: [], dirty: false});
        }

        let includeStreamers = [];
        let excludeStreamers = [];

        const updates = yaml.safeLoad(fs.readFileSync(this.updatename, "utf8"));

        if (!updates.include) {
            updates.include = [];
        } else if (updates.include.length > 0) {
            this.msg(updates.include.length + " streamer(s) to include");
            includeStreamers = updates.include;
            updates.include = [];
        }

        if (!updates.exclude) {
            updates.exclude = [];
        } else if (updates.exclude.length > 0) {
            this.msg(updates.exclude.length + " streamer(s) to exclude");
            excludeStreamers = updates.exclude;
            updates.exclude = [];
        }

        // reset update.yml
        if (includeStreamers.length > 0 || excludeStreamers.length > 0) {
            fs.writeFileSync(this.updatename, yaml.safeDump(updates), "utf8");
        }

        return Promise.try(() => this.updateStreamers(includeStreamers, true)
        ).then((dirty) => this.updateStreamers(excludeStreamers, false) || dirty
        ).then((dirty) => {
            if (dirty) {
                this.writeConfig();
            }
        });
    }

    updateList(streamer, add, isTemp) {
        let dirty = false;
        let list = isTemp ? this.tempList : this.siteConfig.streamers;
        if (add) {
            if (this.addStreamer(streamer, list, isTemp)) {
                list.push(streamer.uid);
                dirty = true;
            }
        } else if (this.removeStreamer(streamer, list)) {
            dirty = true;
            if (this.siteConfig.streamers.indexOf(streamer.uid) !== -1) {
                list = _.without(list, streamer.uid);
            }
        }
        if (dirty) {
            if (isTemp) {
                this.tempList = list;
            } else {
                this.siteConfig.streamers = list;
            }
        }
        return dirty && !isTemp;
    }

    updateStreamers(list, add) {
        let dirty = false;

        for (let i = 0; i < list.length; i++) {
            dirty |= this.updateList(list[i], add, false);
        }

        return dirty;
    }

    addStreamer(streamer, list, isTemp) {
        if (typeof streamer === "undefined") {
            // For mfc, when a bad username is looked up, an empty
            // object is returned
            return false;
        }

        let added = false;
        if (list.indexOf(streamer.uid) === -1) {
            this.msg(colors.name(streamer.nm) + " added to capture list" + (isTemp ? " (temporarily)" : ""));
            added = true;
        } else {
            this.errMsg(colors.name(streamer.nm) + " is already in the capture list");
        }
        if (!this.streamerList.has(streamer.uid)) {
            this.streamerList.set(streamer.uid, {uid: streamer.uid, nm: streamer.nm, site: this.padName, state: "Offline", filename: "", captureProcess: null, postProcess: 0});
            this.tui.render();
        }
        return added;
    }

    removeStreamer(streamer) {
        let dirty = false;
        if (this.streamerList.has(streamer.uid)) {
            this.msg(colors.name(streamer.nm) + " removed from capture list.");
            this.haltCapture(streamer.uid);
            this.streamerList.delete(streamer.uid);
            this.tui.render();
            dirty = true;
        } else {
            this.errMsg(colors.name(streamer.nm) + " not in capture list.");
        }
        return dirty;
    }

    checkStreamerState(streamer, msg, isStreaming, prevState) {
        if (streamer.state !== prevState) {
            this.msg(msg);
        }
        if (streamer.postProcess === 0 && streamer.captureProcess !== null && !isStreaming) {
            // Sometimes the recording process doesn't end when a streamer
            // stops broadcasting, so terminate it.
            this.dbgMsg(colors.name(streamer.nm) + " is no longer broadcasting, ending " + (this.tui.config.streamlink ? "streamlink" : "ffmpeg") + " capture process.");
            this.haltCapture(streamer.uid);
        }
        this.tui.render();
    }

    getStreamers() {
        if (this.tui.tryingToExit) {
            this.dbgMsg("Skipping lookup while exit in progress...");
            return false;
        }
        this.checkFileSize();
        return true;
    }

    storeCapInfo(uid, filename, captureProcess) {
        if (this.streamerList.has(uid)) {
            const streamer = this.streamerList.get(uid);
            streamer.filename = filename;
            streamer.captureProcess = captureProcess;
            this.tui.render();
        }
    }

    getNumCapsInProgress() {
        let count = 0;

        this.streamerList.forEach((value) => {
            count += value.captureProcess !== null;
        });

        return count;
    }

    haltAllCaptures() {
        this.streamerList.forEach((streamer) => {
            // Don't kill post-process jobs, or recording can get lost.
            if (streamer.captureProcess !== null && streamer.postProcess === 0) {
                streamer.captureProcess.kill("SIGINT");
            }
        });
    }

    haltCapture(uid) {
        if (this.streamerList.has(uid)) {
            const streamer = this.streamerList.get(uid);
            if (streamer.captureProcess !== null && streamer.postProcess === 0) {
                streamer.captureProcess.kill("SIGINT");
            }
        }
    }

    writeConfig() {
        this.dbgMsg("Rewriting " + this.cfgname);
        fs.writeFileSync(this.cfgname, yaml.safeDump(this.siteConfig), "utf8");
    }

    setupCapture(uid) {
        if (this.streamerList.has(uid)) {
            const streamer = this.streamerList.get(uid);
            if (streamer.captureProcess !== null) {
                this.dbgMsg(colors.name(streamer.nm) + " is already capturing");
                return false;
            }
            return true;
        }
        return false;
    }

    getCompleteDir(streamer) {
        let completeDir = this.tui.config.completeDirectory;

        if (this.tui.config.streamerSubdir) {
            completeDir += "/" + streamer.nm;
            if (this.tui.config.includeSiteInDir) {
                completeDir += this.siteDir;
            }
            mkdirp.sync(completeDir);
        }

        return completeDir;
    }

    refresh(uid) {
        if (!this.tui.tryingToExit && this.streamerList.has(uid)) {
            const queries = [];
            queries.push(this.checkStreamerState(uid));
            Promise.all(queries).then(() => {
                this.tui.render();
            });
        }
    }

    startCapture(capInfo) {
        if (capInfo.spawnArgs === "") {
            return;
        }

        const streamer = capInfo.streamer;
        const fullname = capInfo.filename + ".ts";
        const capper = this.tui.config.streamlink ? "streamlink" : "ffmpeg";
        const captureProcess = childProcess.spawn(capper, capInfo.spawnArgs);

        if (this.tui.config.debugrecorder) {
            const logStream = fs.createWriteStream("./" + capInfo.filename + ".log", {flags: "w"});
            captureProcess.stdout.pipe(logStream);
            captureProcess.stderr.pipe(logStream);
        }

        if (captureProcess.pid) {
            this.msg(colors.name(streamer.nm) + " recording started (" + capInfo.filename + ".ts)");
            this.storeCapInfo(streamer.uid, fullname, captureProcess);
        }

        captureProcess.on("close", () => {

            fs.stat(this.tui.config.captureDirectory + "/" + fullname, (err, stats) => {
                if (err) {
                    if (err.code === "ENOENT") {
                        this.errMsg(colors.name(streamer.nm) + ", " + capInfo.filename + ".ts not found in capturing directory, cannot convert to " + this.tui.config.autoConvertType);
                    } else {
                        this.errMsg(colors.name(streamer.nm) + ": " + err.toString());
                    }
                    this.storeCapInfo(streamer.uid, "", null);
                } else if (stats.size <= this.tui.config.minByteSize) {
                    this.msg(colors.name(streamer.nm) + " recording automatically deleted (size=" + stats.size + " < minByteSize=" + this.tui.config.minByteSize + ")");
                    fs.unlinkSync(this.tui.config.captureDirectory + "/" + fullname);
                    this.storeCapInfo(streamer.uid, "", null);
                } else {
                    this.postProcess(streamer, capInfo.filename);
                }
            });

            this.refresh(streamer.uid);
        });
    }

    postProcess(streamer, filename) {
        const fullname = filename + ".ts";
        const completeDir = this.getCompleteDir(streamer);

        if (this.tui.config.autoConvertType !== "mp4" && this.tui.config.autoConvertType !== "mkv") {
            this.dbgMsg(colors.name(streamer.nm) + " recording moved (" + this.tui.config.captureDirectory + "/" + filename + ".ts to " + completeDir + "/" + filename + ".ts)");
            mv(this.tui.config.captureDirectory + "/" + fullname, completeDir + "/" + fullname, (err) => {
                if (err) {
                    this.errMsg(colors.site(filename) + ": " + err.toString());
                }
            });

            this.storeCapInfo(streamer.uid, "", null);
            return;
        }

        // Need to remember post-processing is happening, so that
        // the offline check does not kill postprocess jobs.
        let item = null;
        if (this.streamerList.has(streamer.uid)) {
            item = this.streamerList.get(streamer.uid);
            item.postProcess = 1;
        }

        const mySpawnArguments = [
            "-hide_banner",
            "-v",
            "fatal",
            "-i",
            this.tui.config.captureDirectory + "/" + fullname,
            "-c",
            "copy"
        ];

        if (this.tui.config.autoConvertType === "mp4") {
            mySpawnArguments.push("-bsf:a");
            mySpawnArguments.push("aac_adtstoasc");
        }

        mySpawnArguments.push("-copyts");
        mySpawnArguments.push("-start_at_zero");
        mySpawnArguments.push(completeDir + "/" + filename + "." + this.tui.config.autoConvertType);

		// Note: Start Thumbnail Command
		    const myVCSArguments = [
            "-n 20",
            "-c 10",
            "-h 50%",
            "--anonymous",
            completeDir + "/" + filename + "." + this.config.autoConvertType,
        ];
		// Note: End Thumbnail Command

        const myCompleteProcess = childProcess.spawn("ffmpeg", mySpawnArguments);
        this.msg(colors.name(streamer.nm) + " converting to " + filename + "." + this.tui.config.autoConvertType);
        this.storeCapInfo(streamer.uid, filename + "." + this.tui.config.autoConvertType, myCompleteProcess);

        myCompleteProcess.on("close", () => {
            if (!this.tui.config.keepTsFile) {
                fs.unlinkSync(this.tui.config.captureDirectory + "/" + fullname);
            }
		// Note: Start Thumbnail Command
        const myVCSProcess = childProcess.spawn("vcs", myVCSArguments);
		// Note: End Thumbnail Command			
            // Note: setting captureProcess to null releases program to exit
            this.storeCapInfo(streamer.uid, "", null);
            this.msg(colors.name(streamer.nm) + " done converting " + filename + "." + this.tui.config.autoConvertType);

            if (item !== null) {
                item.postProcess = 0;
            }

            this.refresh(streamer.uid);
        });

        myCompleteProcess.on("error", (err) => {
            this.errMsg(err);
        });
    }

    msg(msg) {
        this.tui.log(colors.time("[" + this.getDateTime() + "] ") + colors.site(this.padName) + msg);
    }

    errMsg(msg) {
        this.msg(colors.error("[ERROR] ") + msg);
    }

    dbgMsg(msg) {
        if (this.tui.config.debug) {
            this.msg(colors.debug("[DEBUG] ") + msg);
        }
    }
}

exports.Site = Site;
