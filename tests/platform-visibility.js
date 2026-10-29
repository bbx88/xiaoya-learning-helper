// Captured platform visibility handler used to reproduce its page-hidden pause behavior.
function stopMediaWhenHidden(){document.addEventListener("visibilitychange",function(){document.hidden&&stopAllMedia()})}function stopAllMedia(){document.querySelectorAll("video").forEach(se=>{se.pause()}),document.querySelectorAll("audio").forEach(se=>{se.pause()})}
