-- nowplaying.applescript — lettura e controlli "in riproduzione" di sistema.
--
-- Deve girare CON /usr/bin/osascript: da macOS 15.4 mediaremoted nega
-- l'accesso ai processi senza l'entitlement com.apple.mediaremote.*
-- (serve un binario di piattaforma Apple, qui osascript). Un qualsiasi
-- processo terzo che carica MediaRemote direttamente riceve info vuote.
--
-- Uso: osascript nowplaying.applescript get
--      osascript nowplaying.applescript play|pause|toggle|next|prev
--      osascript nowplaying.applescript seek <secondi>
-- Output stdout: un unico oggetto JSON.
use framework "Foundation"
use scripting additions

on esc(s)
	set out to ""
	repeat with c in characters of (s as text)
		set ch to c as text
		if ch is "\"" then
			set out to out & "\\\""
		else if ch is "\\" then
			set out to out & "\\\\"
		else if ch is linefeed then
			set out to out & "\\n"
		else if ch is return then
			set out to out & "\\r"
		else if ch is tab then
			set out to out & "\\t"
		else
			set out to out & ch
		end if
	end repeat
	return out
end esc

-- valore testuale di una chiave del dizionario now playing ("" se assente)
on val(info, k)
	try
		set v to info's valueForKey:k
		if v is missing value then return ""
		return (v as text)
	on error
		return ""
	end try
end val

-- valore numerico come testo con punto decimale (NSString/NSNumber→stringValue
-- è indipendente dal locale; `as text` darebbe "42,5" in italiano e JSON rotto)
on numText(info, k)
	try
		set v to info's valueForKey:k
		if v is missing value then return "0"
		return (v's stringValue()) as text
	on error
		try
			return ((v as text) as text)
		on error
			return "0"
		end try
	end try
end numText

on loadMR()
	set mr to current application's NSBundle's bundleWithPath:"/System/Library/PrivateFrameworks/MediaRemote.framework/"
	if not (mr's load()) then error "MediaRemote.framework non caricabile"
end loadMR

on getInfo()
	try
		set Rreq to current application's NSClassFromString("MRNowPlayingRequest")
		if Rreq is missing value then return "{}"
		set nrItem to Rreq's localNowPlayingItem()
		if nrItem is missing value then return "{}"
		set info to nrItem's nowPlayingInfo()
		if info is missing value then return "{}"
	on error
		return "{}"
	end try
	set bundleId to ""
	try
		set bp to Rreq's localNowPlayingPlayerPath()
		if bp is not missing value then
			set cl to bp's client()
			if cl is not missing value then set bundleId to (cl's bundleIdentifier()) as text
		end if
	end try
	set t1 to my val(info, "kMRMediaRemoteNowPlayingInfoTitle")
	if t1 is "" then return "{}"
	set ar to my val(info, "kMRMediaRemoteNowPlayingInfoArtist")
	set al to my val(info, "kMRMediaRemoteNowPlayingInfoAlbum")
	set dur to my numText(info, "kMRMediaRemoteNowPlayingInfoDuration")
	set cur to my numText(info, "kMRMediaRemoteNowPlayingInfoElapsedTime")
	set playing to false
	set rate to 1
	try
		set rv to info's valueForKey:"kMRMediaRemoteNowPlayingInfoPlaybackRate"
		if rv is not missing value then set rate to (rv's doubleValue())
		if rv is missing value then
			set playing to true
		else if rate > 0 then
			set playing to true
		end if
	end try
	-- alcune app (es. Spotify dentro Arc) pubblicano il blob UNA sola volta:
	-- elapsedTime è la posizione all'istante del Timestamp e resta fermo.
	-- Si scala a "ora": posizione = elapsed + (now - timestamp) * rate.
	-- Il valore è in secondi; se il timestamp non c'è o è nel futuro, no-op.
	try
		set ts to info's valueForKey:"kMRMediaRemoteNowPlayingInfoTimestamp"
		if ts is not missing value then
			set base to 0
			try
				set base to (my numText(info, "kMRMediaRemoteNowPlayingInfoElapsedTime")) as real
			end try
			set dt to (current application's NSDate's now)'s timeIntervalSinceDate:ts
			if dt > 0 and rate > 0 then
				set adv to base + dt * rate
				set durN to 0
				try
					set durN to (my numText(info, "kMRMediaRemoteNowPlayingInfoDuration")) as real
				end try
				if durN > 0 and adv > durN then set adv to durN
				-- stringa con punto decimale (locale-safe)
				set cur to ((current application's NSNumber's numberWithDouble:adv)'s stringValue()) as text
			end if
		end if
	end try
	set art to ""
	try
		set ad to info's valueForKey:"kMRMediaRemoteNowPlayingInfoArtworkData"
		if ad is not missing value then
			set b64 to (ad's base64EncodedStringWithOptions:0) as text
			if b64 is not "" then
				set mime to my val(info, "kMRMediaRemoteNowPlayingInfoArtworkMIMEType")
				set ext to "jpeg"
				if mime contains "png" then
					set ext to "png"
				else if mime contains "gif" then
					set ext to "gif"
				else if mime contains "webp" then
					set ext to "webp"
				end if
				set art to "data:image/" & ext & ";base64," & b64
			end if
		end if
	end try
	set j to "{"
	set j to j & "\"bundleId\":\"" & my esc(bundleId) & "\","
	set j to j & "\"title\":\"" & my esc(t1) & "\","
	set j to j & "\"artist\":\"" & my esc(ar) & "\","
	set j to j & "\"album\":\"" & my esc(al) & "\","
	set j to j & "\"duration\":" & dur & ","
	set j to j & "\"current\":" & cur & ","
	set j to j & "\"playing\":" & (playing as text) & ","
	set j to j & "\"art\":\"" & my esc(art) & "\""
	set j to j & "}"
	return j
end getInfo

on run argv
	-- solo lettura: i comandi (play/pausa/seek) passano dalla helper
	-- (cmd "mrcommand"), dove MRMediaRemoteSendCommand funziona davvero —
	-- da AppleScriptObjC i C function non vengono risolti
	try
		my loadMR()
	on error errMsg
		return "{\"error\":\"" & my esc(errMsg) & "\"}"
	end try
	return my getInfo()
end run
