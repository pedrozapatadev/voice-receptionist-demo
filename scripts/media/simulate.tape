# Renders docs/media/simulate.gif from a real run of the simulator.
#   vhs scripts/media/simulate.tape
Output docs/media/simulate.gif
Set Shell "bash"
Set FontSize 15
Set Width 1240
Set Height 650
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms
Hide
Type "export PS1='$ ' && clear"
Enter
Show
Type "npm run -s simulate -- --compact"
Sleep 400ms
Enter
Sleep 26s
